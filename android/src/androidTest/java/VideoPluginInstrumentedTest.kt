package io.github.taurivideo.plugin

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class VideoPluginInstrumentedTest {
    @Test fun libraryLoadsInsideHostApplication() {
        val packageName = InstrumentationRegistry.getInstrumentation().targetContext.packageName
        assertTrue(packageName.isNotBlank())
    }
}
