package com.coresubsapp.processing

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Optional foreground service wrapper for the JIT processing pipeline.
 *
 * Starting the pipeline inside a foreground service gives three benefits:
 *  1. Prevents the OS from killing the process mid-chunk during background export.
 *  2. Acquires a PARTIAL_WAKE_LOCK so the CPU/NPU stay active even with screen off.
 *  3. Shows a non-dismissible notification during export (required by Android 14+).
 *
 * The service is only needed during video export. Normal JIT subtitle generation
 * runs on coroutine threads within the app process, which is sufficient while
 * the user is actively viewing the video.
 */
class JITProcessingService : Service() {

    companion object {
        const val CHANNEL_ID = "coresubs_processing"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.coresubsapp.STOP_PROCESSING"
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification("Processing subtitles…"))
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        super.onDestroy()
    }

    fun updateNotification(message: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(message))
    }

    private fun buildNotification(content: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CoreSubs")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "CoreSubs Processing",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Subtitle generation and video export progress"
        }
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "CoreSubs:ProcessingWakeLock",
        ).also { it.acquire(30 * 60 * 1000L /* 30 min max */) }
    }
}
