package io.github.taurivideo.plugin

import org.junit.Assert.assertEquals
import org.junit.Test

class VideoPluginUnitTest {
    @Test fun packageNameIsStable() {
        assertEquals("io.github.taurivideo.plugin", VideoPlugin::class.java.packageName)
    }

    @Test fun absentNativeBufferOverridesUseMedia3Defaults() {
        assertEquals(null, resolveRequestedTargetBufferBytes(null))
        assertEquals(null, resolveRequestedBufferDurations(NativeOpenArgs()))
    }

    @Test fun explicitNativeByteTargetIsClamped() {
        assertEquals(
            8 * 1024 * 1024,
            resolveRequestedTargetBufferBytes(1),
        )
        assertEquals(
            128 * 1024 * 1024,
            resolveRequestedTargetBufferBytes(128L * 1024 * 1024),
        )
    }

    @Test fun explicitMaximumDurationProducesValidMedia3Thresholds() {
        val args = NativeOpenArgs().apply { maxBufferMs = 15_000 }
        assertEquals(
            NativeBufferDurations(15_000, 15_000, 1_000, 2_000),
            resolveRequestedBufferDurations(args),
        )
    }
}
