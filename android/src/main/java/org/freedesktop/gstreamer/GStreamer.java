/*
 * GStreamer Android application-context bridge.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
package org.freedesktop.gstreamer;

import android.content.Context;

/** Supplies GStreamer core with the application's Context and ClassLoader. */
public final class GStreamer {
    private GStreamer() {}

    private static native void nativeInit(Context context) throws Exception;

    public static void init(Context context) throws Exception {
        nativeInit(context);
    }
}
