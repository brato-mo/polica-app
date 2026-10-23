package ba.polica;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

/**
 * Background look at the customer-order tab numbers, about every half hour during the working day. When they differ
 * from what the app read last, a notification says so; the orders themselves are read when the app is opened.
 */
public class OrderWatch extends JobService {
    private static final int JOB_ID = 77;
    private static final String CH = "orders";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("watch", Context.MODE_PRIVATE);
    }

    /** on = look in the background; base = numbers of the last full read, "Aktivan:92,Stigao:45". */
    static void set(Context c, boolean on, String base) {
        String b = base == null ? "" : base;
        SharedPreferences.Editor ed = prefs(c).edit().putBoolean("on", on).putString("base", b);
        if (!b.equals(prefs(c).getString("base", ""))) ed.putString("told", "");
        ed.apply();
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        if (!on) {
            js.cancel(JOB_ID);
            return;
        }
        for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB_ID) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, OrderWatch.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(30 * 60 * 1000L)
            .setPersisted(true)
            .build());
    }

    static Map<String, Integer> parse(String s) {
        Map<String, Integer> m = new HashMap<>();
        if (s == null) return m;
        for (String p : s.split(",")) {
            int i = p.indexOf(':');
            if (i < 1) continue;
            try {
                m.put(p.substring(0, i), Integer.parseInt(p.substring(i + 1).trim()));
            } catch (NumberFormatException ignored) {
            }
        }
        return m;
    }

    private boolean over;

    @Override
    public boolean onStartJob(final JobParameters p) {
        final SharedPreferences sp = prefs(this);
        int h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        if (!sp.getBoolean("on", false) || sp.getString("base", "").isEmpty() || h < 7 || h >= 21) return false;
        over = false;
        StoreProbe.run(this, null, new StoreProbe.Callback() {
            @Override
            public void done(boolean online, String counts) {
                if (over) return;
                over = true;
                try {
                    if (online) compare(sp, counts);
                } catch (Exception ignored) {
                }
                jobFinished(p, false);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) {
        over = true;
        return false;
    }

    private void compare(SharedPreferences sp, String counts) {
        Map<String, Integer> base = parse(sp.getString("base", ""));
        Map<String, Integer> now = parse(counts);
        StringBuilder diff = new StringBuilder();
        for (Map.Entry<String, Integer> e : base.entrySet()) {
            Integer n = now.get(e.getKey());
            if (n == null || n.equals(e.getValue())) continue;
            if (diff.length() > 0) diff.append(", ");
            diff.append(e.getKey()).append(' ').append(n > e.getValue() ? "+" : "").append(n - e.getValue());
        }
        String d = diff.toString();
        if (d.isEmpty() || d.equals(sp.getString("told", ""))) return;
        sp.edit().putString("told", d).apply();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CH, "Narudžbe kupaca", NotificationManager.IMPORTANCE_DEFAULT));
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_mono)
            .setContentTitle("Ima promjena u narudžbama kupaca")
            .setContentText(d + ". Otvori " + getString(R.string.app_name) + " i osvježi.")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        nm.notify(1, n);
    }
}
