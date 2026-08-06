package io.github.taurivideo.plugin

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/** Direct-SurfaceView compatibility backend used only when Media3 cannot render a stream. */
internal class VlcFallbackPlayer(
    context: Context,
    private val videoLayout: VLCVideoLayout,
    private val config: VlcFallbackConfig,
) {
    private val libVlc: LibVLC
    private val player: MediaPlayer
    private val trackTargets = HashMap<Int, VlcTrackTarget>()
    private var bufferingPercent = 0f
    private var lastPresentedFrames = 0L
    private var lastFrameSampleNs = 0L
    private var measuredFps = 0.0
    private var startPositionApplied = false
    private var playingEventReceived = false
    private var videoOutputReceived = false

    init {
        // LibVLC appends its selected audio output and display chroma to this
        // list during construction, so Kotlin's immutable buildList result is
        // not accepted by the Java API.
        val options = ArrayList(buildLibVlcOptions(config))
        val createdLibVlc = LibVLC(context.applicationContext, options)
        try {
            player = MediaPlayer(createdLibVlc)
            libVlc = createdLibVlc
        } catch (error: Throwable) {
            createdLibVlc.release()
            throw error
        }
    }

    fun open(onRenderable: () -> Unit, onError: (String) -> Unit) {
        val completed = AtomicBoolean(false)
        try {
            player.attachViews(videoLayout, null, true, false)
            player.setVideoScale(MediaPlayer.ScaleType.SURFACE_BEST_FIT)
            player.setEventListener { event ->
                when (event.type) {
                    MediaPlayer.Event.Buffering -> bufferingPercent = event.buffering.coerceIn(0f, 100f)
                    MediaPlayer.Event.Playing -> {
                        playingEventReceived = true
                        applyStartPosition()
                        resolveWhenRenderable(completed, onRenderable)
                    }
                    MediaPlayer.Event.Vout -> {
                        videoOutputReceived = event.voutCount > 0
                        resolveWhenRenderable(completed, onRenderable)
                    }
                    MediaPlayer.Event.EncounteredError -> {
                        if (completed.compareAndSet(false, true)) {
                            onError("LibVLC could not decode or read the stream")
                        }
                    }
                }
            }
            val media = Media(libVlc, Uri.parse(config.uri)).apply {
                setHWDecoderEnabled(true, true)
                addOption(":network-caching=${config.networkCachingMs}")
                addOption(":clock-jitter=0")
                addOption(":clock-synchro=0")
                config.userAgent?.takeIf(String::isNotBlank)?.let {
                    addOption(":http-user-agent=$it")
                }
                config.referrer?.takeIf(String::isNotBlank)?.let {
                    addOption(":http-referrer=$it")
                }
                config.cookies?.takeIf(String::isNotBlank)?.let {
                    addOption(":http-cookie=$it")
                    addOption(":http-forward-cookies")
                }
            }
            player.media = media
            media.release()
            player.volume = (config.initialVolume.coerceIn(0f, 1f) * 100f).toInt()
            player.play()
        } catch (error: Throwable) {
            if (completed.compareAndSet(false, true)) {
                onError(error.message ?: "LibVLC compatibility backend failed to start")
            }
        }
    }

    private fun resolveWhenRenderable(completed: AtomicBoolean, onRenderable: () -> Unit) {
        if (!playingEventReceived || !videoOutputReceived || !completed.compareAndSet(false, true)) return
        if (!config.autoplay) player.pause()
        onRenderable()
    }

    private fun applyStartPosition() {
        if (startPositionApplied) return
        startPositionApplied = true
        config.startPositionMs?.takeIf { it > 0L }?.let { player.setTime(it, true) }
    }

    fun play() = player.play()

    fun pause() = player.pause()

    fun seekTo(positionMs: Long) {
        player.setTime(positionMs.coerceAtLeast(0L), true)
    }

    fun setVolume(value: Float) {
        player.volume = (value.coerceIn(0f, 1f) * 100f).toInt()
    }

    fun selectTrack(target: Int) {
        when (val track = trackTargets[target] ?: return) {
            is VlcTrackTarget.Video -> player.setVideoTrack(track.id)
            is VlcTrackTarget.Audio -> player.setAudioTrack(track.id)
            is VlcTrackTarget.Subtitle -> player.setSpuTrack(track.id)
        }
    }

    fun deselectTrack(target: Int) {
        when (trackTargets[target] ?: return) {
            is VlcTrackTarget.Video -> player.setVideoTrackEnabled(false)
            is VlcTrackTarget.Audio -> player.setAudioTrack(-1)
            is VlcTrackTarget.Subtitle -> player.setSpuTrack(-1)
        }
    }

    fun setFit(mode: String) {
        player.setVideoScale(
            when (mode) {
                "crop" -> MediaPlayer.ScaleType.SURFACE_FIT_SCREEN
                "stretch" -> MediaPlayer.ScaleType.SURFACE_FILL
                else -> MediaPlayer.ScaleType.SURFACE_BEST_FIT
            }
        )
    }

    fun setZoom(value: Float) {
        val zoom = value.coerceIn(1f, 2f)
        videoLayout.scaleX = zoom
        videoLayout.scaleY = zoom
    }

    fun snapshot(container: String): VlcSnapshot {
        val media = player.media
        val stats = try {
            media?.stats
        } finally {
            media?.release()
        }
        val presented = stats?.displayedPictures?.toLong()?.coerceAtLeast(0L) ?: 0L
        val dropped = stats?.lostPictures?.toLong()?.coerceAtLeast(0L) ?: 0L
        updateMeasuredFps(presented)
        val durationMs = player.length.coerceAtLeast(0L)
        val currentMs = player.time.coerceAtLeast(0L)
        val estimatedReserveMs = (config.networkCachingMs * (bufferingPercent / 100f)).toLong()
        val bufferedMs = if (durationMs > 0L) min(durationMs, currentMs + estimatedReserveMs)
            else currentMs + estimatedReserveMs
        val video = player.currentVideoTrack
        return VlcSnapshot(
            durationSeconds = durationMs / 1000.0,
            currentTimeSeconds = currentMs / 1000.0,
            bufferedSeconds = bufferedMs / 1000.0,
            playing = player.isPlaying,
            videoWidth = video?.width ?: 0,
            videoHeight = video?.height ?: 0,
            presentedFrames = presented,
            droppedFrames = dropped,
            measuredFps = measuredFps,
            hardwareBackend = "android-libvlc:auto:surface-view",
            encodedBytesBuffered = 0L,
            averageFrameProcessingUs = 0.0,
            container = container,
            tracks = collectTracks(),
        )
    }

    private fun updateMeasuredFps(presented: Long) {
        val nowNs = SystemClock.elapsedRealtimeNanos()
        if (lastFrameSampleNs == 0L) {
            lastFrameSampleNs = nowNs
            lastPresentedFrames = presented
        } else if (nowNs - lastFrameSampleNs >= 500_000_000L) {
            val elapsedSeconds = (nowNs - lastFrameSampleNs) / 1_000_000_000.0
            measuredFps = (presented - lastPresentedFrames).coerceAtLeast(0L) / elapsedSeconds
            lastFrameSampleNs = nowNs
            lastPresentedFrames = presented
        }
    }

    private fun collectTracks(): List<VlcTrack> {
        val descriptions = buildList {
            player.videoTracks?.filter { it.id >= 0 }?.forEach { add(Triple("video", it.id, it.name)) }
            player.audioTracks?.filter { it.id >= 0 }?.forEach { add(Triple("audio", it.id, it.name)) }
            player.spuTracks?.filter { it.id >= 0 }?.forEach { add(Triple("subtitle", it.id, it.name)) }
        }
        val media = player.media
        val mediaTracks = try {
            buildMap<Int, IMedia.Track> {
                if (media != null) {
                    for (index in 0 until media.trackCount) {
                        media.getTrack(index)?.let { put(it.id, it) }
                    }
                }
            }
        } finally {
            media?.release()
        }
        trackTargets.clear()
        return descriptions.mapIndexed { target, (kind, id, name) ->
            trackTargets[target] = when (kind) {
                "video" -> VlcTrackTarget.Video(id)
                "audio" -> VlcTrackTarget.Audio(id)
                else -> VlcTrackTarget.Subtitle(id)
            }
            val track = mediaTracks[id]
            val selected = when (kind) {
                "video" -> player.videoTrack == id
                "audio" -> player.audioTrack == id
                else -> player.spuTrack == id
            }
            VlcTrack(
                id = target,
                kind = kind,
                language = track?.language ?: "und",
                label = name?.takeIf(String::isNotBlank) ?: track?.description ?: kind,
                codec = track?.codec ?: track?.originalCodec ?: "",
                selected = selected,
            )
        }
    }

    fun release() {
        runCatching { player.stop() }
        runCatching { player.detachViews() }
        player.release()
        libVlc.release()
        trackTargets.clear()
    }
}

internal data class VlcFallbackConfig(
    val uri: String,
    val autoplay: Boolean,
    val initialVolume: Float,
    val startPositionMs: Long?,
    val networkCachingMs: Int,
    val userAgent: String?,
    val referrer: String?,
    val cookies: String?,
    val caFile: File?,
)

internal data class VlcSnapshot(
    val durationSeconds: Double,
    val currentTimeSeconds: Double,
    val bufferedSeconds: Double,
    val playing: Boolean,
    val videoWidth: Int,
    val videoHeight: Int,
    val presentedFrames: Long,
    val droppedFrames: Long,
    val measuredFps: Double,
    val hardwareBackend: String,
    val encodedBytesBuffered: Long,
    val averageFrameProcessingUs: Double,
    val container: String,
    val tracks: List<VlcTrack>,
)

internal data class VlcTrack(
    val id: Int,
    val kind: String,
    val language: String,
    val label: String,
    val codec: String,
    val selected: Boolean,
)

private sealed class VlcTrackTarget(open val id: Int) {
    data class Video(override val id: Int) : VlcTrackTarget(id)
    data class Audio(override val id: Int) : VlcTrackTarget(id)
    data class Subtitle(override val id: Int) : VlcTrackTarget(id)
}

private fun buildLibVlcOptions(config: VlcFallbackConfig): List<String> = buildList {
    add("--no-video-title-show")
    add("--network-caching=${config.networkCachingMs}")
    add("--file-caching=${config.networkCachingMs}")
    add("--live-caching=${config.networkCachingMs}")
    add("--codec=mediacodec_ndk,mediacodec_jni,avcodec,all")
    config.caFile?.parentFile?.let { add("--gnutls-dir-trust=${it.absolutePath}") }
}
