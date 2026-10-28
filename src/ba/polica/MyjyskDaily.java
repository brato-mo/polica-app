package ba.polica;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.util.Calendar;

/**
 * Every morning at 8:00 the MYJYSK tasks and news are read in the background (MyjyskJob). An alarm wakes the phone
 * around 8:00 (Android may shift it by a few minutes) and hands the reading to a job that waits for the network.
 * The alarm is set again after each run, after a restart of the phone and after an update of the app.
 */
public class MyjyskDaily extends BroadcastReceiver {
    static final String ACTION = "ba.polica.MYJYSK_DAILY";
    static final int HOUR = 8;
    private static final int JOB_ID = 78;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("myjysk", Context.MODE_PRIVATE);
    }

    static void set(Context c, boolean on) {
        prefs(c).edit().putBoolean("on", on).apply();
        if (on && MyjyskReader.enabled(c)) arm(c);
        else cancel(c);
    }

    private static PendingIntent pending(Context c) {
        Intent i = new Intent(c, MyjyskDaily.class).setAction(ACTION);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static long next(long now) {
        Calendar k = Calendar.getInstance();
        k.setTimeInMillis(now);
        k.set(Calendar.HOUR_OF_DAY, HOUR);
        k.set(Calendar.MINUTE, 0);
        k.set(Calendar.SECOND, 0);
        k.set(Calendar.MILLISECOND, 0);
        if (k.getTimeInMillis() <= now) k.add(Calendar.DAY_OF_MONTH, 1);
        return k.getTimeInMillis();
    }

    static void arm(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next(System.currentTimeMillis()), pending(c));
        } catch (RuntimeException ignored) {
        }
    }

    private static void cancel(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(c));
    }

    /** The reading itself, as soon as there is a network (at most 15 minutes late). */
    static void runNow(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        JobInfo.Builder b = new JobInfo.Builder(JOB_ID, new ComponentName(c, MyjyskJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setOverrideDeadline(15 * 60 * 1000L);
        try {
            js.schedule(b.build());
        } catch (RuntimeException e) {
            try {
                js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, MyjyskJob.class)).setOverrideDeadline(60 * 1000L).build());
            } catch (RuntimeException ignored) {
            }
        }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        if (!prefs(c).getBoolean("on", true) || !MyjyskReader.enabled(c)) return;
        String a = intent == null ? null : intent.getAction();
        arm(c);
        if (ACTION.equals(a)) runNow(c);
    }
}
