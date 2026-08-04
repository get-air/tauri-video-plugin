package io.github.taurivideo.plugin

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.upstream.DefaultAllocator
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayInputStream
import java.io.File
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import org.freedesktop.gstreamer.GStreamer

/** Android/TV integration with a direct SurfaceView playback plane. */
@TauriPlugin
class VideoPlugin(private val activity: Activity) : Plugin(activity) {
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var nativeView: PlayerView? = null
    private var nativePlayer: ExoPlayer? = null
    private var videoSize = VideoSize.UNKNOWN
    private val trackTargets = HashMap<Int, Pair<Tracks.Group, Int>>()
    private var allocator: DefaultAllocator? = null
    private var videoDecoderName = "uninitialized"
    private var lastRenderedFrames = 0L
    private var lastFrameSampleNs = 0L
    private var measuredFps = 0.0
    private val bundledCaFile: File
    private var nativeContainer = "unknown"

    init {
        bundledCaFile = File(activity.filesDir, "tauri-video-ca-certificates.crt")
        activity.assets.open("tauri-video-ca-certificates.crt").use { input ->
            bundledCaFile.outputStream().use(input::copyTo)
        }
        GStreamerBootstrap.setTlsCaFile(bundledCaFile.absolutePath)
        GStreamer.init(activity.applicationContext)
    }

    override fun load(webView: WebView) {
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        var transparentAncestor: View? = webView
        while (transparentAncestor != null && transparentAncestor !== activity.window.decorView) {
            transparentAncestor.setBackgroundColor(Color.TRANSPARENT)
            transparentAncestor = transparentAncestor.parent as? View
        }
        activity.runOnUiThread {
            val playerView = PlayerView(activity).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(Color.BLACK)
                val uiType = resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
                subtitleView?.setBottomPaddingFraction(
                    if (uiType == Configuration.UI_MODE_TYPE_TELEVISION) 0.24f else 0.16f
                )
                visibility = View.GONE
            }
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            root.addView(playerView, 0, FrameLayout.LayoutParams(1, 1))
            nativeView = playerView
        }
    }

    @Command
    fun openNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeOpenArgs::class.java)
        activity.runOnUiThread {
            closeNativePlayer()
            val view = nativeView
            if (view == null) {
                invoke.reject("native video surface is unavailable")
                return@runOnUiThread
            }
            applyNativeLayout(args.x, args.y, args.width, args.height)
            view.visibility = View.VISIBLE
            view.videoSurfaceView?.apply {
                scaleX = 1f
                scaleY = 1f
            }
            nativeContainer = containerFromUri(args.uri)
            val minBufferMs = (args.minBufferMs ?: 12_000).coerceIn(1_000, 120_000)
            val maxBufferMs = (args.maxBufferMs ?: 45_000).coerceIn(minBufferMs, 180_000)
            val playbackBufferMs = (args.playbackBufferMs ?: 2_500).coerceIn(250, minBufferMs)
            val rebufferMs = (args.rebufferMs ?: 6_000).coerceIn(500, minBufferMs)
            val targetBufferBytes = (args.targetBufferBytes ?: 96L * 1024 * 1024)
                .coerceIn(8L * 1024 * 1024, 512L * 1024 * 1024)
                .toInt()
            val playerAllocator = DefaultAllocator(true, 64 * 1024)
            allocator = playerAllocator
            val loadControl = DefaultLoadControl.Builder()
                // The byte ceiling is the final guardrail on low-memory TV boxes.
                .setAllocator(playerAllocator)
                .setBufferDurationsMs(minBufferMs, maxBufferMs, playbackBufferMs, rebufferMs)
                .setTargetBufferBytes(targetBufferBytes)
                .setPrioritizeTimeOverSizeThresholds(false)
                .build()
            // Several Amlogic TV firmwares advertise Dolby Vision profile 7
            // decoders that open successfully but render black. Profile 7 has
            // a standards-compliant HEVC base layer, so select the HEVC codec
            // directly and keep the zero-copy SurfaceView path.
            val codecSelector = MediaCodecSelector { mimeType, secure, tunneling ->
                val decoderMime = if (
                    mimeType == MimeTypes.VIDEO_DOLBY_VISION
                    && args.dolbyVisionMode != "platform"
                ) {
                    MimeTypes.VIDEO_H265
                } else mimeType
                MediaCodecSelector.DEFAULT.getDecoderInfos(decoderMime, secure, tunneling)
            }
            val renderersFactory = DefaultRenderersFactory(activity)
                .setMediaCodecSelector(codecSelector)
                .setEnableDecoderFallback(args.decoderFallback ?: true)
            val requestHeaders = HashMap(args.headers)
            args.cookies?.takeIf(String::isNotBlank)?.let { requestHeaders["Cookie"] = it }
            args.referrer?.takeIf(String::isNotBlank)?.let { requestHeaders["Referer"] = it }
            val httpFactory = try {
                createHttpDataSourceFactory(args, requestHeaders)
            } catch (error: Exception) {
                view.visibility = View.GONE
                invoke.reject(error.message ?: "Could not configure the HTTPS media source")
                return@runOnUiThread
            }
            val dataSourceFactory = DefaultDataSource.Factory(activity, httpFactory)
            val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
            val trackSelector = DefaultTrackSelector(activity).apply {
                parameters = buildUponParameters()
                    .setTunnelingEnabled(args.tunneling ?: false)
                    .build()
            }
            val player = ExoPlayer.Builder(activity)
                .setRenderersFactory(renderersFactory)
                .setMediaSourceFactory(mediaSourceFactory)
                .setTrackSelector(trackSelector)
                .setLoadControl(loadControl)
                .build()
            nativePlayer = player
            view.player = player
            player.addAnalyticsListener(object : AnalyticsListener {
                override fun onVideoDecoderInitialized(
                    eventTime: AnalyticsListener.EventTime,
                    decoderName: String,
                    initializedTimestampMs: Long,
                    initializationDurationMs: Long,
                ) {
                    videoDecoderName = decoderName
                }
            })
            val resolved = AtomicBoolean(false)
            var playerReady = false
            var firstFrameRendered = false
            fun resolveWhenRenderable() {
                if (playerReady && firstFrameRendered && resolved.compareAndSet(false, true)) {
                    invoke.resolve(nativeSnapshot(player))
                }
            }
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY) {
                        playerReady = true
                        resolveWhenRenderable()
                    }
                }

                override fun onRenderedFirstFrame() {
                    firstFrameRendered = true
                    resolveWhenRenderable()
                }

                override fun onPlayerError(error: PlaybackException) {
                    if (resolved.compareAndSet(false, true)) {
                        invoke.reject(error.message ?: "Media3 playback failed")
                    }
                }

                override fun onVideoSizeChanged(size: VideoSize) {
                    videoSize = size
                }
            })
            val mediaItem = MediaItem.fromUri(args.uri)
            val startPositionMs = args.startPositionSeconds
                ?.takeIf { it.isFinite() && it >= 0.0 }
                ?.times(1_000.0)
                ?.toLong()
            if (startPositionMs == null) player.setMediaItem(mediaItem)
            else player.setMediaItem(mediaItem, startPositionMs)
            if (args.autoplay && setPlaybackActive(true)) {
                // Arm autoplay while the player is still buffering. Media3 will
                // begin immediately on READY instead of waiting for a second
                // manual play transition.
                player.playWhenReady = true
            }
            player.prepare()
        }
    }

    @Command
    fun controlNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeControlArgs::class.java)
        activity.runOnUiThread {
            val player = nativePlayer
            if (player == null) {
                invoke.reject("native player is not open")
                return@runOnUiThread
            }
            try {
                when (args.action) {
                    "play" -> {
                        check(setPlaybackActive(true)) { "audio focus was denied" }
                        player.play()
                    }
                    "pause" -> {
                        player.pause()
                        setPlaybackActive(false)
                    }
                    "seek" -> player.seekTo((args.value * 1000.0).toLong())
                    "volume" -> player.volume = args.value.toFloat().coerceIn(0f, 1f)
                    "track" -> selectNativeTrack(player, args.index)
                    "deselectTrack" -> deselectNativeTrack(player, args.index)
                    "fit" -> nativeView?.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    "crop" -> nativeView?.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                    "stretch" -> nativeView?.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FILL
                    "zoom" -> nativeView?.videoSurfaceView?.apply {
                        val zoom = args.value.toFloat().coerceIn(1f, 2f)
                        scaleX = zoom
                        scaleY = zoom
                    }
                    else -> throw IllegalArgumentException("unknown native action ${args.action}")
                }
                invoke.resolve(nativeSnapshot(player))
            } catch (error: Exception) {
                invoke.reject(error.message ?: "native playback command failed")
            }
        }
    }

    @Command
    fun layoutNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeLayoutArgs::class.java)
        activity.runOnUiThread {
            applyNativeLayout(args.x, args.y, args.width, args.height)
            invoke.resolve()
        }
    }

    @Command
    fun statsNative(invoke: Invoke) {
        activity.runOnUiThread {
            val player = nativePlayer
            if (player == null) invoke.reject("native player is not open")
            else player.playerError?.let { invoke.reject(it.message ?: "Media3 playback failed") }
                ?: invoke.resolve(nativeSnapshot(player))
        }
    }

    @Command
    fun closeNative(invoke: Invoke) {
        activity.runOnUiThread {
            closeNativePlayer()
            invoke.resolve()
        }
    }

    @Command
    fun setPlaybackState(invoke: Invoke) {
        val args = invoke.parseArgs(PlaybackArgs::class.java)
        if (setPlaybackActive(args.playing)) invoke.resolve()
        else invoke.reject("audio focus was denied")
    }

    private fun setPlaybackActive(playing: Boolean): Boolean {
        if (!playing) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let(audioManager::abandonAudioFocusRequest)
                focusRequest = null
            } else {
                @Suppress("DEPRECATION")
                audioManager.abandonAudioFocus(null)
            }
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            return true
        }
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build()
                )
                .setOnAudioFocusChangeListener { change ->
                    if (change == AudioManager.AUDIOFOCUS_LOSS
                        || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                    ) {
                        activity.runOnUiThread { nativePlayer?.pause() }
                    }
                }
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
        return if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            true
        } else false
    }

    private fun selectNativeTrack(player: ExoPlayer, target: Int) {
        val (group, track) = trackTargets[target] ?: return
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(group.type, false)
            .clearOverridesOfType(group.type)
            .addOverride(TrackSelectionOverride(group.mediaTrackGroup, track))
            .build()
    }

    private fun deselectNativeTrack(player: ExoPlayer, target: Int) {
        val (group, _) = trackTargets[target] ?: return
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(group.type, true)
            .build()
    }

    /** Build an HTTPS source with an explicit CA bundle without disabling hostname validation. */
    private fun createHttpDataSourceFactory(
        args: NativeOpenArgs,
        requestHeaders: Map<String, String>,
    ): HttpDataSource.Factory {
        val caFile = when (val requested = args.tlsCaFile?.trim()) {
            null, "" -> null
            "bundled" -> bundledCaFile
            else -> File(requested).takeIf { it.isFile }
                ?: throw IllegalArgumentException("TLS CA file is unavailable to the Android app")
        }
        if (caFile == null) {
            return DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setUserAgent(args.userAgent ?: DEFAULT_USER_AGENT)
                .setDefaultRequestProperties(requestHeaders)
        }

        val certificateFactory = CertificateFactory.getInstance("X.509")
        val certificates = PEM_CERTIFICATE.findAll(caFile.readText()).map { match ->
            ByteArrayInputStream(match.value.toByteArray(Charsets.US_ASCII)).use {
                certificateFactory.generateCertificate(it)
            }
        }.toList()
        require(certificates.isNotEmpty()) { "TLS CA bundle contains no certificates" }
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            certificates.forEachIndexed { index, certificate ->
                setCertificateEntry("tauri-video-ca-$index", certificate)
            }
        }
        val trustManagerFactory = TrustManagerFactory
            .getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(keyStore) }
        val trustManager = trustManagerFactory.trustManagers
            .filterIsInstance<X509TrustManager>()
            .singleOrNull()
            ?: error("TLS CA bundle did not create an X.509 trust manager")
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), null)
        }
        val client = OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .build()
        return OkHttpDataSource.Factory(client)
            .setUserAgent(args.userAgent ?: DEFAULT_USER_AGENT)
            .setDefaultRequestProperties(requestHeaders)
    }

    private fun applyNativeLayout(x: Double, y: Double, width: Double, height: Double) {
        val view = nativeView ?: return
        val params = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(1, 1)
        params.width = width.toInt().coerceAtLeast(1)
        params.height = height.toInt().coerceAtLeast(1)
        params.leftMargin = x.toInt().coerceAtLeast(0)
        params.topMargin = y.toInt().coerceAtLeast(0)
        view.layoutParams = params
    }

    private fun nativeSnapshot(player: ExoPlayer): JSObject {
        val counters = player.videoDecoderCounters
        counters?.ensureUpdated()
        val presentedFrames = counters?.renderedOutputBufferCount?.toLong()?.coerceAtLeast(0) ?: 0L
        val droppedFrames = counters?.droppedBufferCount?.toLong()?.coerceAtLeast(0) ?: 0L
        val nowNs = SystemClock.elapsedRealtimeNanos()
        if (lastFrameSampleNs == 0L) {
            lastFrameSampleNs = nowNs
            lastRenderedFrames = presentedFrames
        } else if (nowNs - lastFrameSampleNs >= 500_000_000L) {
            val elapsedSeconds = (nowNs - lastFrameSampleNs) / 1_000_000_000.0
            measuredFps = (presentedFrames - lastRenderedFrames).coerceAtLeast(0) / elapsedSeconds
            lastFrameSampleNs = nowNs
            lastRenderedFrames = presentedFrames
        }
        val processingCount = counters?.videoFrameProcessingOffsetCount ?: 0
        val averageProcessingUs = if (processingCount > 0) {
            (counters?.totalVideoFrameProcessingOffsetUs ?: 0L).toDouble() / processingCount
        } else 0.0
        val tracks = ArrayList<JSObject>()
        trackTargets.clear()
        var target = 0
        player.currentTracks.groups.forEach { group ->
            val kind = when (group.type) {
                C.TRACK_TYPE_VIDEO -> "video"
                C.TRACK_TYPE_AUDIO -> "audio"
                C.TRACK_TYPE_TEXT -> "subtitle"
                else -> return@forEach
            }
            for (index in 0 until group.length) {
                val format: Format = group.getTrackFormat(index)
                val language = format.language ?: "und"
                trackTargets[target] = group to index
                tracks.add(JSObject().apply {
                    put("id", target.toString())
                    put("index", target)
                    put("kind", kind)
                    put("language", language)
                    put("label", format.label ?: if (language == "und") kind else language.uppercase())
                    put("codec", format.codecs ?: format.sampleMimeType?.substringAfter('/') ?: "")
                    put("selected", group.isTrackSelected(index))
                })
                target += 1
            }
        }
        val durationMs = player.duration.takeIf { it != C.TIME_UNSET }?.coerceAtLeast(0) ?: 0
        return JSObject().apply {
            put("durationSeconds", durationMs / 1000.0)
            put("currentTimeSeconds", player.currentPosition.coerceAtLeast(0) / 1000.0)
            put("bufferedSeconds", player.bufferedPosition.coerceAtLeast(0) / 1000.0)
            put("playing", player.isPlaying)
            put("videoWidth", videoSize.width)
            put("videoHeight", videoSize.height)
            put("presentedFrames", presentedFrames)
            put("droppedFrames", droppedFrames)
            put("measuredFps", measuredFps)
            put("hardwareBackend", "android-mediacodec:$videoDecoderName:surface-view")
            put("encodedBytesBuffered", allocator?.totalBytesAllocated?.toLong() ?: 0L)
            put("averageFrameProcessingUs", averageProcessingUs)
            put("container", nativeContainer)
            put("tracks", JSArray.from(tracks.toTypedArray()))
        }
    }

    private fun closeNativePlayer() {
        setPlaybackActive(false)
        nativeView?.player = null
        nativePlayer?.release()
        nativePlayer = null
        nativeView?.visibility = View.GONE
        allocator = null
        videoDecoderName = "uninitialized"
        lastRenderedFrames = 0L
        lastFrameSampleNs = 0L
        measuredFps = 0.0
        nativeContainer = "unknown"
        trackTargets.clear()
        videoSize = VideoSize.UNKNOWN
    }
}

private fun containerFromUri(value: String): String {
    val name = Uri.parse(value).lastPathSegment?.substringBefore('?')?.lowercase() ?: return "unknown"
    return when {
        name.endsWith(".mkv") || name.endsWith(".mka") -> "matroska"
        name.endsWith(".webm") -> "webm"
        name.endsWith(".mp4") || name.endsWith(".m4v") -> "mp4"
        name.endsWith(".avi") -> "avi"
        name.endsWith(".ts") || name.endsWith(".m2ts") -> "mpeg-ts"
        name.endsWith(".mov") -> "quicktime"
        else -> "unknown"
    }
}

@InvokeArg class PlaybackArgs { var playing: Boolean = false }
@InvokeArg class NativeOpenArgs {
    var uri: String = ""; var x: Double = 0.0; var y: Double = 0.0
    var width: Double = 1.0; var height: Double = 1.0; var autoplay: Boolean = false
    var headers: HashMap<String, String> = HashMap()
    var cookies: String? = null; var userAgent: String? = null; var referrer: String? = null
    var tlsCaFile: String? = null; var startPositionSeconds: Double? = null
    var minBufferMs: Int? = null; var maxBufferMs: Int? = null
    var playbackBufferMs: Int? = null; var rebufferMs: Int? = null
    var targetBufferBytes: Long? = null; var decoderFallback: Boolean? = null
    var dolbyVisionMode: String? = null; var tunneling: Boolean? = null
}
@InvokeArg class NativeLayoutArgs {
    var x: Double = 0.0; var y: Double = 0.0; var width: Double = 1.0; var height: Double = 1.0
}
@InvokeArg class NativeControlArgs {
    var action: String = ""; var value: Double = 0.0; var index: Int = -1
}

private const val DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36"
private val PEM_CERTIFICATE = Regex(
    "-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----"
)
