package ba.polica;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps the reading of the customer orders going when the phone is locked: a foreground service with a notification
 * (the process is not put to sleep) and a partial wake lock (the processor keeps running). OrdersActivity starts it,
 * sends the progress text and stops it when the reading ends. Nothing is read here; the page reading stays in the
 * activity.
 */
public class ReadService extends Service {
    static final String CH = "reading";
    static final int NOTE = 2;
    private static final String EXTRA_TEXT = "text";
    private static final long WAKE_MS = 30L * 60 * 1000; // a long reading ends by itself after this

    private PowerManager.WakeLock wake;

    // Android can refuse a service start; the reading goes on without the service then, so nothing here may throw.
    static void start(Context c, String text) {
        try {
            Intent i = new Intent(c, ReadService.class).putExtra(EXTRA_TEXT, text);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (RuntimeException ignored) {
        }
    }

    /** Only the notification text changes. */
    static void note(Context c, String text) {
        try {
            c.startService(new Intent(c, ReadService.class).putExtra(EXTRA_TEXT, text));
        } catch (RuntimeException ignored) {
        }
    }

    static void stop(Context c) {
        try {
            c.stopService(new Intent(c, ReadService.class));
        } catch (RuntimeException ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) text = "Čitam narudžbe kupaca…";
        text = text.replace('\n', ' ');
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CH, "Čitanje narudžbi", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        Notification n = b
            .setSmallIcon(R.drawable.ic_mono)
            .setContentTitle("Čitam narudžbe kupaca")
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
        startForeground(NOTE, n);
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "polica:read");
                wake.setReferenceCounted(false);
                wake.acquire(WAKE_MS);
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
