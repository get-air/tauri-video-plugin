package io.github.taurivideo.plugin;

/** Registers GStreamer's optional AndroidMedia plugin after core startup. */
public final class GStreamerBootstrap {
    private GStreamerBootstrap() {}

    public static native void setTlsCaFile(String path);
    public static native boolean registerAndroidMedia();
}
