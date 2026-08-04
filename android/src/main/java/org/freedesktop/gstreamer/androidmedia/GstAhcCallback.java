/*
 * GStreamer Android camera JNI bridge.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
package org.freedesktop.gstreamer.androidmedia;

import android.hardware.Camera;

@SuppressWarnings("deprecation")
public final class GstAhcCallback implements Camera.PreviewCallback,
        Camera.ErrorCallback, Camera.AutoFocusCallback {
    public long mUserData;
    public long mCallback;

    public static native void gst_ah_camera_on_preview_frame(
            byte[] data, Camera camera, long callback, long userData);
    public static native void gst_ah_camera_on_error(
            int error, Camera camera, long callback, long userData);
    public static native void gst_ah_camera_on_auto_focus(
            boolean success, Camera camera, long callback, long userData);

    public GstAhcCallback(long callback, long userData) {
        mCallback = callback;
        mUserData = userData;
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera camera) {
        gst_ah_camera_on_preview_frame(data, camera, mCallback, mUserData);
    }

    @Override
    public void onError(int error, Camera camera) {
        gst_ah_camera_on_error(error, camera, mCallback, mUserData);
    }

    @Override
    public void onAutoFocus(boolean success, Camera camera) {
        gst_ah_camera_on_auto_focus(success, camera, mCallback, mUserData);
    }
}
