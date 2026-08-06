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
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
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
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import org.videolan.libvlc.util.VLCVideoLayout

/** Android/TV integration with a direct SurfaceView playback plane. */
@TauriPlugin
class VideoPlugin(private val activity: Activity) : Plugin(activity) {
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private var focusRequest: AudioFocusRequest? = null
    private var nativeRoot: FrameLayout? = null
    private var nativeView: PlayerView? = null
    private var vlcView: VLCVideoLayout? = null
    private var nativePlayer: ExoPlayer? = null
    private var vlcPlayer: VlcFallbackPlayer? = null
    private var startupFallback: Runnable? = null
    private var openGeneration = 0
    private var activeSessionKey: String? = null
    private var videoSize = VideoSize.UNKNOWN
    private val trackTargets = HashMap<Int, Pair<Tracks.Group, Int>>()
    private var allocator: DefaultAllocator? = null
    private var videoDecoderName = "uninitialized"
    private var lastRenderedFrames = 0L
    private var lastFrameSampleNs = 0L
    private var measuredFps = 0.0
    private val bundledCaFile: File?
    private var nativeContainer = "unknown"

    init {
        bundledCaFile = runCatching {
            val trustDirectory = File(activity.filesDir, "tauri-video-ca").apply { mkdirs() }
            File(trustDirectory, "ca-certificates.crt").also { destination ->
                activity.assets.open("tauri-video-ca-certificates.crt").use { input ->
                    destination.outputStream().use(input::copyTo)
                }
            }
        }.getOrNull()
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
            val nativeContainer = FrameLayout(activity).apply {
                setBackgroundColor(Color.BLACK)
                visibility = View.GONE
            }
            val playerView = PlayerView(activity).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(Color.BLACK)
                val uiType = resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
                subtitleView?.setBottomPaddingFraction(
                    if (uiType == Configuration.UI_MODE_TYPE_TELEVISION) 0.24f else 0.16f
                )
            }
            val compatibilityView = VLCVideoLayout(activity).apply { visibility = View.GONE }
            val match = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            nativeContainer.addView(playerView, match)
            nativeContainer.addView(compatibilityView, match)
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            root.addView(nativeContainer, 0, FrameLayout.LayoutParams(1, 1))
            nativeRoot = nativeContainer
            nativeView = playerView
            vlcView = compatibilityView
        }
    }

    @Command
    fun openNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeOpenArgs::class.java)
        activity.runOnUiThread {
            closeNativePlayer()
            activeSessionKey = args.sessionKey
            val generation = openGeneration
            val view = nativeView
            val root = nativeRoot
            if (view == null || root == null) {
                invoke.reject("native video surface is unavailable")
                return@runOnUiThread
            }
            applyNativeLayout(args.x, args.y, args.width, args.height)
            root.visibility = View.VISIBLE
            view.visibility = View.VISIBLE
            vlcView?.visibility = View.GONE
            view.videoSurfaceView?.apply {
                scaleX = 1f
                scaleY = 1f
            }
            nativeContainer = containerFromUri(args.uri)
            val requestedBackend = args.backend?.lowercase() ?: "auto"
            if (requestedBackend !in setOf("auto", "media3", "libvlc")) {
                root.visibility = View.GONE
                invoke.reject("backend '$requestedBackend' is not available on Android")
                return@runOnUiThread
            }
            if (requestedBackend == "libvlc") {
                startVlcFallback(
                    args,
                    invoke,
                    AtomicBoolean(false),
                    generation,
                    "LibVLC was explicitly requested",
                )
                return@runOnUiThread
            }
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
                root.visibility = View.GONE
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
            player.volume = if (args.muted) 0f else args.volume.toFloat().coerceIn(0f, 1f)
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
            val fallbackStarted = AtomicBoolean(false)
            var playerReady = false
            var firstFrameRendered = false
            fun resolveWhenRenderable() {
                if (playerReady
                    && (firstFrameRendered || !args.autoplay)
                    && resolved.compareAndSet(false, true)
                ) {
                    cancelStartupFallback()
                    invoke.resolve(nativeSnapshot(player))
                }
            }
            fun fallbackOrReject(message: String) {
                if (requestedBackend == "media3"
                    || args.compatibilityFallback == "disabled"
                    || args.decoderFallback == false
                ) {
                    if (resolved.compareAndSet(false, true)) {
                        cancelStartupFallback()
                        invoke.reject(message)
                    }
                } else if (fallbackStarted.compareAndSet(false, true)) {
                    cancelStartupFallback()
                    startVlcFallback(args, invoke, resolved, generation, message)
                }
            }
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY) {
                        compatibilityReason(player)?.let {
                            fallbackOrReject(it)
                            return
                        }
                        playerReady = true
                        resolveWhenRenderable()
                    }
                }

                override fun onRenderedFirstFrame() {
                    firstFrameRendered = true
                    resolveWhenRenderable()
                }

                override fun onPlayerError(error: PlaybackException) {
                    fallbackOrReject(error.message ?: "Media3 playback failed")
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
            if (requestedBackend != "media3"
                && args.compatibilityFallback != "disabled"
                && args.decoderFallback != false
            ) {
                val timeoutMs = (args.startupTimeoutMs ?: 8_000).coerceIn(2_000, 60_000)
                startupFallback = Runnable {
                    if (generation == openGeneration && !resolved.get()) {
                        fallbackOrReject("Media3 did not render a frame within ${timeoutMs}ms")
                    }
                }.also { mainHandler.postDelayed(it, timeoutMs.toLong()) }
            }
        }
    }

    @Command
    fun controlNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeControlArgs::class.java)
        activity.runOnUiThread {
            if (args.sessionKey != activeSessionKey) {
                invoke.reject("native player session is stale")
                return@runOnUiThread
            }
            val player = nativePlayer
            val fallback = vlcPlayer
            if (player == null && fallback == null) {
                invoke.reject("native player is not open")
                return@runOnUiThread
            }
            try {
                when (args.action) {
                    "play" -> {
                        check(setPlaybackActive(true)) { "audio focus was denied" }
                        player?.play() ?: fallback?.play()
                    }
                    "pause" -> {
                        player?.pause() ?: fallback?.pause()
                        setPlaybackActive(false)
                    }
                    "seek" -> if (player != null) player.seekTo((args.value * 1000.0).toLong())
                        else fallback?.seekTo((args.value * 1000.0).toLong())
                    "volume" -> if (player != null) {
                        player.volume = args.value.toFloat().coerceIn(0f, 1f)
                    } else fallback?.setVolume(args.value.toFloat())
                    "track" -> if (player != null) selectNativeTrack(player, args.index)
                        else fallback?.selectTrack(args.index)
                    "deselectTrack" -> if (player != null) deselectNativeTrack(player, args.index)
                        else fallback?.deselectTrack(args.index)
                    "fit", "crop", "stretch" -> if (player != null) {
                        nativeView?.resizeMode = when (args.action) {
                            "crop" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                            "stretch" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                            else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
                        }
                    } else fallback?.setFit(args.action)
                    "zoom" -> if (player != null) {
                        nativeView?.videoSurfaceView?.apply {
                            val zoom = args.value.toFloat().coerceIn(1f, 2f)
                            scaleX = zoom
                            scaleY = zoom
                        }
                    } else {
                        fallback?.setZoom(args.value.toFloat())
                    }
                    else -> throw IllegalArgumentException("unknown native action ${args.action}")
                }
                invoke.resolve(activeNativeSnapshot())
            } catch (error: Exception) {
                invoke.reject(error.message ?: "native playback command failed")
            }
        }
    }

    @Command
    fun layoutNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeLayoutArgs::class.java)
        activity.runOnUiThread {
            if (args.sessionKey != activeSessionKey) {
                invoke.reject("native player session is stale")
                return@runOnUiThread
            }
            applyNativeLayout(args.x, args.y, args.width, args.height)
            invoke.resolve()
        }
    }

    @Command
    fun statsNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeSessionArgs::class.java)
        activity.runOnUiThread {
            if (args.sessionKey != activeSessionKey) {
                invoke.reject("native player session is stale")
                return@runOnUiThread
            }
            val player = nativePlayer
            val fallback = vlcPlayer
            if (player == null && fallback == null) invoke.reject("native player is not open")
            else player?.playerError?.let { invoke.reject(it.message ?: "Media3 playback failed") }
                ?: invoke.resolve(activeNativeSnapshot())
        }
    }

    @Command
    fun closeNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeSessionArgs::class.java)
        activity.runOnUiThread {
            if (args.sessionKey == activeSessionKey) closeNativePlayer()
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
                        activity.runOnUiThread {
                            nativePlayer?.pause()
                            vlcPlayer?.pause()
                        }
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

    private fun compatibilityReason(player: ExoPlayer): String? {
        val videoGroups = player.currentTracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
        if (videoGroups.isEmpty()) return "Media3 did not expose a playable video track"
        if (videoGroups.none(Tracks.Group::isSupported)) {
            return "Media3 has no decoder for the video's format"
        }
        val nativeMimes = setOf(
            MimeTypes.VIDEO_H264,
            MimeTypes.VIDEO_H265,
            MimeTypes.VIDEO_DOLBY_VISION,
            MimeTypes.VIDEO_VP8,
            MimeTypes.VIDEO_VP9,
            MimeTypes.VIDEO_AV1,
            MimeTypes.VIDEO_MPEG2,
            MimeTypes.VIDEO_MP4V,
        )
        val selectedFormats = videoGroups.flatMap { group ->
            (0 until group.length)
                .filter(group::isTrackSelected)
                .map(group::getTrackFormat)
        }
        if (selectedFormats.any { it.sampleMimeType !in nativeMimes }) {
            return "Media3 selected a video format outside the native decoder path"
        }
        return null
    }

    private fun deselectNativeTrack(player: ExoPlayer, target: Int) {
        val (group, _) = trackTargets[target] ?: return
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(group.type, true)
            .build()
    }

    private fun startVlcFallback(
        args: NativeOpenArgs,
        invoke: Invoke,
        resolved: AtomicBoolean,
        generation: Int,
        media3Failure: String,
    ) {
        if (generation != openGeneration || vlcPlayer != null) return
        val root = nativeRoot
        val compatibilityView = vlcView
        if (root == null || compatibilityView == null) {
            if (resolved.compareAndSet(false, true)) invoke.reject("LibVLC video surface is unavailable")
            return
        }
        val resumePositionMs = nativePlayer?.currentPosition
            ?.takeIf { it > 0L }
            ?: args.startPositionSeconds?.times(1_000.0)?.toLong()
        nativeView?.player = null
        nativePlayer?.release()
        nativePlayer = null
        allocator = null
        nativeView?.visibility = View.GONE
        compatibilityView.visibility = View.VISIBLE
        root.visibility = View.VISIBLE
        val fallback = try {
            VlcFallbackPlayer(
                activity,
                compatibilityView,
                VlcFallbackConfig(
                    uri = args.uri,
                    autoplay = args.autoplay,
                    initialVolume = if (args.muted) 0f else args.volume.toFloat().coerceIn(0f, 1f),
                    startPositionMs = resumePositionMs,
                    networkCachingMs = (args.minBufferMs ?: 8_000).coerceIn(1_000, 20_000),
                    userAgent = args.userAgent,
                    referrer = args.referrer,
                    cookies = args.cookies,
                    caFile = resolveCaFile(args),
                ),
            )
        } catch (error: Throwable) {
            Log.e("TauriVideo", "LibVLC compatibility backend failed to initialize", error)
            compatibilityView.visibility = View.GONE
            root.visibility = View.GONE
            if (resolved.compareAndSet(false, true)) {
                invoke.reject(
                    "$media3Failure; LibVLC startup failed: ${error.javaClass.simpleName}: " +
                        (error.message ?: "no diagnostic message")
                )
            }
            return
        }
        vlcPlayer = fallback
        compatibilityView.post {
            if (generation != openGeneration || vlcPlayer !== fallback) return@post
            fallback.open(
                onRenderable = {
                    activity.runOnUiThread {
                        if (generation != openGeneration || vlcPlayer !== fallback) return@runOnUiThread
                        if (args.autoplay) setPlaybackActive(true)
                        if (resolved.compareAndSet(false, true)) {
                            invoke.resolve(activeNativeSnapshot())
                        }
                    }
                },
                onError = { vlcFailure ->
                    activity.runOnUiThread {
                        if (generation != openGeneration || vlcPlayer !== fallback) return@runOnUiThread
                        fallback.release()
                        vlcPlayer = null
                        compatibilityView.visibility = View.GONE
                        root.visibility = View.GONE
                        if (resolved.compareAndSet(false, true)) {
                            invoke.reject("$media3Failure; $vlcFailure")
                        }
                    }
                },
            )
        }
    }

    private fun cancelStartupFallback() {
        startupFallback?.let(mainHandler::removeCallbacks)
        startupFallback = null
    }

    private fun activeNativeSnapshot(): JSObject {
        nativePlayer?.let { return nativeSnapshot(it) }
        val fallback = vlcPlayer ?: error("native player is not open")
        return vlcSnapshot(fallback.snapshot(nativeContainer))
    }

    private fun vlcSnapshot(snapshot: VlcSnapshot): JSObject {
        val tracks = snapshot.tracks.map { track ->
            JSObject().apply {
                put("id", track.id.toString())
                put("index", track.id)
                put("kind", track.kind)
                put("language", track.language)
                put("label", track.label)
                put("codec", track.codec)
                put("selected", track.selected)
            }
        }
        return JSObject().apply {
            put("durationSeconds", snapshot.durationSeconds)
            put("currentTimeSeconds", snapshot.currentTimeSeconds)
            put("bufferedSeconds", snapshot.bufferedSeconds)
            put("playing", snapshot.playing)
            put("videoWidth", snapshot.videoWidth)
            put("videoHeight", snapshot.videoHeight)
            put("presentedFrames", snapshot.presentedFrames)
            put("droppedFrames", snapshot.droppedFrames)
            put("measuredFps", snapshot.measuredFps)
            put("hardwareBackend", snapshot.hardwareBackend)
            put("encodedBytesBuffered", snapshot.encodedBytesBuffered)
            put("averageFrameProcessingUs", snapshot.averageFrameProcessingUs)
            put("container", snapshot.container)
            put("tracks", JSArray.from(tracks.toTypedArray()))
        }
    }

    private fun resolveCaFile(args: NativeOpenArgs): File? = when (val requested = args.tlsCaFile?.trim()) {
        null, "" -> null
        "bundled" -> bundledCaFile
            ?: throw IllegalArgumentException("Bundled TLS CA file is unavailable to the Android app")
        else -> File(requested).takeIf { it.isFile }
            ?: throw IllegalArgumentException("TLS CA file is unavailable to the Android app")
    }

    /** Build an HTTPS source with an explicit CA bundle without disabling hostname validation. */
    private fun createHttpDataSourceFactory(
        args: NativeOpenArgs,
        requestHeaders: Map<String, String>,
    ): HttpDataSource.Factory {
        val caFile = resolveCaFile(args)
        if (caFile == null) {
            val factory = DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setDefaultRequestProperties(requestHeaders)
            args.userAgent?.takeIf(String::isNotBlank)?.let(factory::setUserAgent)
            return factory
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
        val customTrustManager = trustManagerFactory.trustManagers
            .filterIsInstance<X509TrustManager>()
            .singleOrNull()
            ?: error("TLS CA bundle did not create an X.509 trust manager")
        val systemTrustManager = TrustManagerFactory
            .getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(null as KeyStore?) }
            .trustManagers
            .filterIsInstance<X509TrustManager>()
            .singleOrNull()
            ?: error("Android did not provide a system X.509 trust manager")
        val trustManager = CompositeTrustManager(systemTrustManager, customTrustManager)
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), null)
        }
        val client = OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .build()
        val factory = OkHttpDataSource.Factory(client)
            .setDefaultRequestProperties(requestHeaders)
        args.userAgent?.takeIf(String::isNotBlank)?.let(factory::setUserAgent)
        return factory
    }

    private fun applyNativeLayout(x: Double, y: Double, width: Double, height: Double) {
        val view = nativeRoot ?: return
        val params = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(1, 1)
        params.width = width.toInt().coerceAtLeast(1)
        params.height = height.toInt().coerceAtLeast(1)
        params.leftMargin = x.toInt()
        params.topMargin = y.toInt()
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
        openGeneration += 1
        activeSessionKey = null
        cancelStartupFallback()
        setPlaybackActive(false)
        nativeView?.player = null
        nativePlayer?.release()
        nativePlayer = null
        vlcPlayer?.release()
        vlcPlayer = null
        nativeView?.visibility = View.VISIBLE
        vlcView?.visibility = View.GONE
        nativeRoot?.visibility = View.GONE
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
    var sessionKey: String = ""
    var uri: String = ""; var x: Double = 0.0; var y: Double = 0.0
    var backend: String? = null
    var width: Double = 1.0; var height: Double = 1.0; var autoplay: Boolean = false
    var volume: Double = 1.0; var muted: Boolean = false
    var headers: HashMap<String, String> = HashMap()
    var cookies: String? = null; var userAgent: String? = null; var referrer: String? = null
    var tlsCaFile: String? = null; var startPositionSeconds: Double? = null
    var minBufferMs: Int? = null; var maxBufferMs: Int? = null
    var playbackBufferMs: Int? = null; var rebufferMs: Int? = null
    var targetBufferBytes: Long? = null; var decoderFallback: Boolean? = null
    var dolbyVisionMode: String? = null; var tunneling: Boolean? = null
    var compatibilityFallback: String? = null; var startupTimeoutMs: Int? = null
}
@InvokeArg class NativeLayoutArgs {
    var sessionKey: String = ""
    var x: Double = 0.0; var y: Double = 0.0; var width: Double = 1.0; var height: Double = 1.0
}
@InvokeArg class NativeControlArgs {
    var sessionKey: String = ""
    var action: String = ""; var value: Double = 0.0; var index: Int = -1
}
@InvokeArg class NativeSessionArgs { var sessionKey: String = "" }

private val PEM_CERTIFICATE = Regex(
    "-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----"
)

private class CompositeTrustManager(
    private val system: X509TrustManager,
    private val custom: X509TrustManager,
) : X509TrustManager {
    override fun getAcceptedIssuers(): Array<X509Certificate> =
        system.acceptedIssuers + custom.acceptedIssuers

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        system.checkClientTrusted(chain, authType)
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        try {
            system.checkServerTrusted(chain, authType)
        } catch (systemError: CertificateException) {
            try {
                custom.checkServerTrusted(chain, authType)
            } catch (customError: CertificateException) {
                customError.addSuppressed(systemError)
                throw customError
            }
        }
    }
}
