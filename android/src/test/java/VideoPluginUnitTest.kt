package io.github.taurivideo.plugin

import org.junit.Assert.assertEquals
import org.junit.Test

class VideoPluginUnitTest {
    @Test fun packageNameIsStable() {
        assertEquals("io.github.taurivideo.plugin", VideoPlugin::class.java.packageName)
    }
}
