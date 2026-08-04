/*
 * GStreamer Android sensor JNI bridge.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
package org.freedesktop.gstreamer.androidmedia;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;

public final class GstAhsCallback implements SensorEventListener {
    public long mUserData;
    public long mSensorCallback;
    public long mAccuracyCallback;

    public static native void gst_ah_sensor_on_sensor_changed(
            SensorEvent event, long callback, long userData);
    public static native void gst_ah_sensor_on_accuracy_changed(
            Sensor sensor, int accuracy, long callback, long userData);

    public GstAhsCallback(long sensorCallback, long accuracyCallback, long userData) {
        mSensorCallback = sensorCallback;
        mAccuracyCallback = accuracyCallback;
        mUserData = userData;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        gst_ah_sensor_on_sensor_changed(event, mSensorCallback, mUserData);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        gst_ah_sensor_on_accuracy_changed(sensor, accuracy, mAccuracyCallback, mUserData);
    }
}
