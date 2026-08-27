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
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.SurfaceView
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
    private var focusRequest: AudioFocusRequest? = null
    private var nativeRoot: FrameLayout? = null
    private var nativeView: PlayerView? = null
    private var vlcView: VLCVideoLayout? = null
    private var hostWebView: WebView? = null
    private var nativeDocumentX = 0.0
    private var nativeDocumentY = 0.0
    private var nativeLayoutActive = false
    private var nativeScrollSynchronizerRegistered = false
    private val nativeScrollSynchronizer = ViewTreeObserver.OnPreDrawListener {
        syncNativeScrollPosition()
        true
    }
    private var nativePlayer: ExoPlayer? = null
    private var vlcPlayer: VlcPlayer? = null
    private var openGeneration = 0
    private var activeSessionKey: String? = null
    private var videoSize = VideoSize.UNKNOWN
    private val trackTargets = HashMap<Int, Pair<Tracks.Group, Int>>()
    private var cachedNativeTracks = JSArray()
    private var cachedVlcTrackSource: List<VlcTrack>? = null
    private var cachedVlcTracks = JSArray()
    private val customCaClients = object : LinkedHashMap<String, OkHttpClient>(4, 0.75f, true) {
        override fun removeEldestEntry(
            eldest: MutableMap.MutableEntry<String, OkHttpClient>?,
        ): Boolean = size > 4
    }
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
            unregisterNativeScrollSynchronizer()
            hostWebView = webView
            registerNativeScrollSynchronizerIfNeeded()
            ensureNativeSurfaceHost()
        }
    }

    /** Create the native playback plane beneath Tauri's Android WebView. */
    private fun ensureNativeSurfaceHost() {
        if (nativeRoot != null && nativeView != null && vlcView != null) return
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
        val vlcLayout = VLCVideoLayout(activity).apply { visibility = View.GONE }
        val match = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        )
        nativeContainer.addView(playerView, match)
        nativeContainer.addView(vlcLayout, match)
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        root.addView(nativeContainer, 0, FrameLayout.LayoutParams(1, 1))
        rendererSurfaces(nativeContainer).forEach {
            it.setZOrderOnTop(false)
            it.setZOrderMediaOverlay(false)
        }
        nativeRoot = nativeContainer
        nativeView = playerView
        vlcView = vlcLayout
    }

    private fun rendererSurfaces(root: View): List<SurfaceView> {
        if (root is SurfaceView) return listOf(root)
        if (root !is ViewGroup) return emptyList()
        return buildList {
            for (index in 0 until root.childCount) {
                addAll(rendererSurfaces(root.getChildAt(index)))
            }
        }
    }

    @Command
    fun openNative(invoke: Invoke) {
        val args = invoke.parseArgs(NativeOpenArgs::class.java)
        activity.runOnUiThread {
            closeNativePlayer()
            if (hostWebView == null) {
                invoke.reject("native video requires an initialized Tauri WebView")
                return@runOnUiThread
            }
            ensureNativeSurfaceHost()
            activeSessionKey = args.sessionKey
            val generation = openGeneration
            val view = nativeView
            val root = nativeRoot
            if (view == null || root == null) {
                invoke.reject("native video surface is unavailable")
                return@runOnUiThread
            }
            applyNativeLayout(
                args.x,
                args.y,
                args.width,
                args.height,
                args.scrollX,
                args.scrollY,
            )
            root.visibility = View.VISIBLE
            view.visibility = View.VISIBLE
            vlcView?.visibility = View.GONE
            view.videoSurfaceView?.apply {
                scaleX = 1f
                scaleY = 1f
            }
            nativeContainer = containerFromUri(args.uri)
            val requestedBackend = args.backend?.lowercase() ?: "media3"
            if (requestedBackend !in setOf("media3", "libvlc")) {
                root.visibility = View.GONE
                deactivateNativeLayout()
                invoke.reject("backend '$requestedBackend' is not available on Android")
                return@runOnUiThread
            }
            if (requestedBackend == "libvlc") {
                startVlc(
                    args,
                    invoke,
                    AtomicBoolean(false),
                    generation,
                )
                return@runOnUiThread
            }
            val playerAllocator = DefaultAllocator(true, 64 * 1024)
            allocator = playerAllocator
            val loadControlBuilder = DefaultLoadControl.Builder().setAllocator(playerAllocator)
            resolveRequestedBufferDurations(args)?.let { durations ->
                loadControlBuilder.setBufferDurationsMs(
                    durations.minMs,
                    durations.maxMs,
                    durations.playbackMs,
                    durations.rebufferMs,
                )
            }
            resolveRequestedTargetBufferBytes(args.targetBufferBytes)?.let {
                loadControlBuilder.setTargetBufferBytes(it)
            }
            val loadControl = loadControlBuilder.build()
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
                deactivateNativeLayout()
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
            var playerReady = false
            var firstFrameRendered = false
            fun resolveWhenRenderable() {
                if (playerReady
                    && (firstFrameRendered || !args.autoplay)
                    && resolved.compareAndSet(false, true)
                ) {
                    invoke.resolve(nativeSnapshot(player))
                }
            }
            fun rejectMedia3(message: String) {
                if (resolved.compareAndSet(false, true)) {
                    invoke.reject(message)
                    closeNativePlayer()
                }
            }
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY) {
                        // onTracksChanged normally arrives before READY, but initialize from
                        // the authoritative player state so the first resolved snapshot can
                        // never expose an empty cache because of callback ordering.
                        refreshNativeTracks(player.currentTracks)
                        playerReady = true
                        resolveWhenRenderable()
                    } else if (state == Player.STATE_ENDED) {
                        // ExoPlayer keeps playWhenReady armed at EOF. Clear it
                        // so a later seek behaves like an ended HTML video:
                        // update the frame, but stay paused until play() is
                        // explicitly requested.
                        player.playWhenReady = false
                        setPlaybackActive(false)
                    }
                }

                override fun onRenderedFirstFrame() {
                    firstFrameRendered = true
                    resolveWhenRenderable()
                }

                override fun onPlayerError(error: PlaybackException) {
                    rejectMedia3(error.message ?: "Media3 playback failed")
                }

                override fun onVideoSizeChanged(size: VideoSize) {
                    videoSize = size
                }

                override fun onTracksChanged(tracks: Tracks) {
                    refreshNativeTracks(tracks)
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
            if (args.sessionKey != activeSessionKey) {
                invoke.reject("native player session is stale")
                return@runOnUiThread
            }
            val player = nativePlayer
            val vlc = vlcPlayer
            if (player == null && vlc == null) {
                invoke.reject("native player is not open")
                return@runOnUiThread
            }
            try {
                when (args.action) {
                    "play" -> {
                        check(setPlaybackActive(true)) { "audio focus was denied" }
                        if (player != null) {
                            if (player.playbackState == Player.STATE_ENDED) {
                                player.seekToDefaultPosition()
                            }
                            player.play()
                        } else vlc?.play()
                    }
                    "pause" -> {
                        player?.pause() ?: vlc?.pause()
                        setPlaybackActive(false)
                    }
                    "seek" -> if (player != null) player.seekTo((args.value * 1000.0).toLong())
                        else vlc?.seekTo((args.value * 1000.0).toLong())
                    "volume" -> if (player != null) {
                        player.volume = args.value.toFloat().coerceIn(0f, 1f)
                    } else vlc?.setVolume(args.value.toFloat())
                    "track" -> if (player != null) selectNativeTrack(player, args.index)
                        else vlc?.selectTrack(args.index)
                    "deselectTrack" -> if (player != null) deselectNativeTrack(player, args.index)
                        else vlc?.deselectTrack(args.index)
                    "fit", "crop", "stretch" -> if (player != null) {
                        nativeView?.resizeMode = when (args.action) {
                            "crop" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                            "stretch" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                            else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
                        }
                    } else vlc?.setFit(args.action)
                    "zoom" -> if (player != null) {
                        nativeView?.videoSurfaceView?.apply {
                            val zoom = args.value.toFloat().coerceIn(1f, 2f)
                            scaleX = zoom
                            scaleY = zoom
                        }
                    } else {
                        vlc?.setZoom(args.value.toFloat())
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
            applyNativeLayout(
                args.x,
                args.y,
                args.width,
                args.height,
                args.scrollX,
                args.scrollY,
            )
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
            val vlc = vlcPlayer
            if (player == null && vlc == null) invoke.reject("native player is not open")
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
        refreshNativeTracks(player.currentTracks)
    }

    private fun deselectNativeTrack(player: ExoPlayer, target: Int) {
        val (group, _) = trackTargets[target] ?: return
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setTrackTypeDisabled(group.type, true)
            .build()
        refreshNativeTracks(player.currentTracks)
    }

    private fun startVlc(
        args: NativeOpenArgs,
        invoke: Invoke,
        resolved: AtomicBoolean,
        generation: Int,
    ) {
        if (generation != openGeneration || vlcPlayer != null) return
        val root = nativeRoot
        val vlcLayout = vlcView
        if (root == null || vlcLayout == null) {
            root?.visibility = View.GONE
            deactivateNativeLayout()
            if (resolved.compareAndSet(false, true)) invoke.reject("LibVLC video surface is unavailable")
            return
        }
        clearVlcTrackCache()
        nativeView?.visibility = View.GONE
        vlcLayout.visibility = View.VISIBLE
        root.visibility = View.VISIBLE
        val vlc = try {
            VlcPlayer(
                activity,
                vlcLayout,
                VlcPlayerConfig(
                    uri = args.uri,
                    autoplay = args.autoplay,
                    initialVolume = if (args.muted) 0f else args.volume.toFloat().coerceIn(0f, 1f),
                    startPositionMs = args.startPositionSeconds?.times(1_000.0)?.toLong(),
                    networkCachingMs = args.minBufferMs?.coerceIn(1_000, 120_000),
                    userAgent = args.userAgent,
                    referrer = args.referrer,
                    cookies = args.cookies,
                    caFile = resolveCaFile(args),
                ),
            )
        } catch (error: Throwable) {
            Log.e("TauriVideo", "LibVLC backend failed to initialize", error)
            vlcLayout.visibility = View.GONE
            root.visibility = View.GONE
            deactivateNativeLayout()
            if (resolved.compareAndSet(false, true)) {
                invoke.reject(
                    "LibVLC startup failed: ${error.javaClass.simpleName}: " +
                        (error.message ?: "no diagnostic message")
                )
            }
            return
        }
        vlcPlayer = vlc
        vlcLayout.post {
            if (generation != openGeneration || vlcPlayer !== vlc) return@post
            vlc.open(
                onRenderable = {
                    activity.runOnUiThread {
                        if (generation != openGeneration || vlcPlayer !== vlc) return@runOnUiThread
                        if (args.autoplay) setPlaybackActive(true)
                        if (resolved.compareAndSet(false, true)) {
                            invoke.resolve(activeNativeSnapshot())
                        }
                    }
                },
                onError = { vlcFailure ->
                    activity.runOnUiThread {
                        if (generation != openGeneration || vlcPlayer !== vlc) return@runOnUiThread
                        vlc.release()
                        vlcPlayer = null
                        vlcLayout.visibility = View.GONE
                        root.visibility = View.GONE
                        deactivateNativeLayout()
                        if (resolved.compareAndSet(false, true)) {
                            invoke.reject(vlcFailure)
                        }
                    }
                },
            )
        }
    }

    private fun activeNativeSnapshot(): JSObject {
        nativePlayer?.let { return nativeSnapshot(it) }
        val vlc = vlcPlayer ?: error("native player is not open")
        return vlcSnapshot(vlc.snapshot(nativeContainer))
    }

    private fun vlcSnapshot(snapshot: VlcSnapshot): JSObject {
        val tracks = vlcTrackArray(snapshot.tracks)
        return JSObject().apply {
            put("durationSeconds", snapshot.durationSeconds)
            put("currentTimeSeconds", snapshot.currentTimeSeconds)
            put("bufferedSeconds", snapshot.bufferedSeconds)
            put("live", snapshot.live)
            put("seekable", snapshot.seekable)
            put("seekableStartSeconds", snapshot.seekableStartSeconds)
            put("seekableEndSeconds", snapshot.seekableEndSeconds)
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
            put("tracks", tracks)
        }
    }

    private fun vlcTrackArray(tracks: List<VlcTrack>): JSArray {
        if (cachedVlcTrackSource === tracks) return cachedVlcTracks
        cachedVlcTrackSource = tracks
        cachedVlcTracks = JSArray(tracks.map { track ->
            JSObject().apply {
                put("id", track.id.toString())
                put("index", track.id)
                put("kind", track.kind)
                put("language", track.language)
                put("label", track.label)
                put("codec", track.codec)
                put("selected", track.selected)
            }
        })
        return cachedVlcTracks
    }

    private fun clearVlcTrackCache() {
        cachedVlcTrackSource = null
        cachedVlcTracks = JSArray()
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

        val cacheKey = "${caFile.canonicalPath}:${caFile.length()}:${caFile.lastModified()}"
        val client = customCaClients.getOrPut(cacheKey) { buildCustomCaClient(caFile) }
        val factory = OkHttpDataSource.Factory(client)
            .setDefaultRequestProperties(requestHeaders)
        args.userAgent?.takeIf(String::isNotBlank)?.let(factory::setUserAgent)
        return factory
    }

    private fun buildCustomCaClient(caFile: File): OkHttpClient {
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
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .build()
    }

    private fun applyNativeLayout(
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        scrollX: Double,
        scrollY: Double,
    ) {
        val view = nativeRoot ?: return
        val params = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(1, 1)
        val nextWidth = width.toInt().coerceAtLeast(1)
        val nextHeight = height.toInt().coerceAtLeast(1)
        if (params.width != nextWidth || params.height != nextHeight
            || params.leftMargin != 0 || params.topMargin != 0
        ) {
            params.width = nextWidth
            params.height = nextHeight
            params.leftMargin = 0
            params.topMargin = 0
            view.layoutParams = params
        }
        nativeDocumentX = x + scrollX
        nativeDocumentY = y + scrollY
        nativeLayoutActive = true
        registerNativeScrollSynchronizerIfNeeded()
        syncNativeScrollPosition()
    }

    private fun registerNativeScrollSynchronizerIfNeeded() {
        if (!nativeLayoutActive || nativeScrollSynchronizerRegistered) return
        val observer = hostWebView?.viewTreeObserver?.takeIf { it.isAlive } ?: return
        observer.addOnPreDrawListener(nativeScrollSynchronizer)
        nativeScrollSynchronizerRegistered = true
    }

    private fun unregisterNativeScrollSynchronizer() {
        if (!nativeScrollSynchronizerRegistered) return
        hostWebView?.viewTreeObserver?.takeIf { it.isAlive }
            ?.removeOnPreDrawListener(nativeScrollSynchronizer)
        nativeScrollSynchronizerRegistered = false
    }

    private fun deactivateNativeLayout() {
        nativeLayoutActive = false
        unregisterNativeScrollSynchronizer()
    }

    private fun syncNativeScrollPosition() {
        if (!nativeLayoutActive) return
        val view = nativeRoot ?: return
        val webView = hostWebView ?: return
        val nextX = (nativeDocumentX - webView.scrollX).toFloat()
        val nextY = (nativeDocumentY - webView.scrollY).toFloat()
        if (view.translationX != nextX) view.translationX = nextX
        if (view.translationY != nextY) view.translationY = nextY
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
        val durationMs = player.duration.takeIf { it != C.TIME_UNSET }?.coerceAtLeast(0) ?: 0
        val live = player.isCurrentMediaItemLive
        val seekable = player.isCurrentMediaItemSeekable
        val seekableEndMs = if (durationMs > 0) durationMs else maxOf(
            player.currentPosition,
            player.bufferedPosition,
        ).coerceAtLeast(0)
        return JSObject().apply {
            put("durationSeconds", durationMs / 1000.0)
            put("currentTimeSeconds", player.currentPosition.coerceAtLeast(0) / 1000.0)
            put("bufferedSeconds", player.bufferedPosition.coerceAtLeast(0) / 1000.0)
            put("live", live)
            put("seekable", seekable)
            put("seekableStartSeconds", 0.0)
            put("seekableEndSeconds", seekableEndMs / 1000.0)
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
            put("tracks", cachedNativeTracks)
        }
    }

    private fun refreshNativeTracks(tracks: Tracks) {
        val cachedTracks = ArrayList<JSObject>()
        trackTargets.clear()
        var target = 0
        tracks.groups.forEach { group ->
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
                cachedTracks.add(JSObject().apply {
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
        cachedNativeTracks = JSArray(cachedTracks)
    }

    private fun clearNativeTrackCache() {
        trackTargets.clear()
        cachedNativeTracks = JSArray()
    }

    private fun closeNativePlayer() {
        openGeneration += 1
        activeSessionKey = null
        setPlaybackActive(false)
        nativeView?.player = null
        nativePlayer?.release()
        nativePlayer = null
        vlcPlayer?.release()
        vlcPlayer = null
        nativeView?.visibility = View.VISIBLE
        vlcView?.visibility = View.GONE
        nativeRoot?.visibility = View.GONE
        deactivateNativeLayout()
        allocator = null
        videoDecoderName = "uninitialized"
        lastRenderedFrames = 0L
        lastFrameSampleNs = 0L
        measuredFps = 0.0
        nativeContainer = "unknown"
        clearNativeTrackCache()
        clearVlcTrackCache()
        videoSize = VideoSize.UNKNOWN
    }
}

internal data class NativeBufferDurations(
    val minMs: Int,
    val maxMs: Int,
    val playbackMs: Int,
    val rebufferMs: Int,
)

internal fun resolveRequestedBufferDurations(args: NativeOpenArgs): NativeBufferDurations? {
    if (
        args.minBufferMs == null && args.maxBufferMs == null &&
        args.playbackBufferMs == null && args.rebufferMs == null
    ) return null

    val requestedMaxMs = args.maxBufferMs?.coerceIn(1_000, 180_000)
    val minMs = (args.minBufferMs
        ?: requestedMaxMs?.coerceAtMost(DefaultLoadControl.DEFAULT_MIN_BUFFER_MS)
        ?: DefaultLoadControl.DEFAULT_MIN_BUFFER_MS)
        .coerceIn(1_000, 120_000)
    val maxMs = (requestedMaxMs ?: DefaultLoadControl.DEFAULT_MAX_BUFFER_MS)
        .coerceIn(minMs, 180_000)
    return NativeBufferDurations(
        minMs = minMs,
        maxMs = maxMs,
        playbackMs = (args.playbackBufferMs ?: DefaultLoadControl.DEFAULT_BUFFER_FOR_PLAYBACK_MS)
            .coerceIn(250, minMs),
        rebufferMs = (
            args.rebufferMs
                ?: DefaultLoadControl.DEFAULT_BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS
            ).coerceIn(500, minMs),
    )
}

internal fun resolveRequestedTargetBufferBytes(requestedBytes: Long?): Int? = requestedBytes
    ?.coerceIn(8L * 1024 * 1024, 512L * 1024 * 1024)
    ?.toInt()

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

@InvokeArg class NativeOpenArgs {
    var sessionKey: String = ""
    var uri: String = ""; var x: Double = 0.0; var y: Double = 0.0
    var scrollX: Double = 0.0; var scrollY: Double = 0.0
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
}
@InvokeArg class NativeLayoutArgs {
    var sessionKey: String = ""
    var x: Double = 0.0; var y: Double = 0.0; var width: Double = 1.0; var height: Double = 1.0
    var scrollX: Double = 0.0; var scrollY: Double = 0.0
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
