package ba.polica;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * The 8:00 reading of MYJYSK. Keeps the answer in data/myjysk-in.json, where the app picks it up when it is opened,
 * and sends a notification when there are new tasks or news, or when MYJYSK wants the employee to sign in again.
 */
public class MyjyskJob extends JobService {
    static final String FILE = "myjysk-in.json";
    private static final String CH = "myjysk";
    private boolean over;

    static File file(Context c) {
        File d = new File(c.getFilesDir(), "data");
        if (!d.isDirectory()) d.mkdirs();
        return new File(d, FILE);
    }

    @Override
    public boolean onStartJob(final JobParameters p) {
        over = false;
        try {
            MyjyskProbe.run(this, null, new MyjyskProbe.Callback() {
                @Override
                public void done(String how, JSONObject data) {
                    if (over) return;
                    over = true;
                    try {
                        keep(how, data);
                    } catch (Throwable ignored) {
                    }
                    jobFinished(p, false);
                }
            });
        } catch (Throwable e) {
            return false;
        }
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) {
        over = true;
        return false;
    }

    private void keep(String how, JSONObject data) throws Exception {
        if ("off".equals(how)) return;
        JSONObject old = read(this);
        JSONObject o = new JSONObject();
        o.put("how", how);
        o.put("at", System.currentTimeMillis());
        o.put("auto", true);
        if (data != null) o.put("data", data);
        else if (old != null && old.optJSONObject("data") != null) o.put("data", old.optJSONObject("data")); // keep the last good read
        MainActivity.writeAtomic(file(this), o.toString().getBytes(StandardCharsets.UTF_8));
        if ("ok".equals(how)) {
            JSONObject before = old == null ? null : old.optJSONObject("data");
            int tasks = fresh(before, data, "my") + fresh(before, data, "loc");
            int news = fresh(before, data, "news") + fresh(before, data, "sys");
            if (before == null || tasks + news == 0) return;
            StringBuilder t = new StringBuilder();
            if (tasks > 0) t.append(tasks).append(tasks == 1 ? " novi zadatak" : tasks < 5 ? " nova zadatka" : " novih zadataka");
            if (news > 0) t.append(t.length() > 0 ? ", " : "").append(news).append(news == 1 ? " nova vijest" : news < 5 ? " nove vijesti" : " novih vijesti");
            notify("MYJYSK: " + t, "Otvori " + getString(R.string.app_name) + " → Vijesti.");
        } else if ("login".equals(how)) {
            notify("MYJYSK traži prijavu", "Otvori " + getString(R.string.app_name) + " → Vijesti i prijavi se ponovo.");
        }
    }

    static JSONObject read(Context c) {
        File f = file(c);
        if (!f.isFile()) return null;
        try {
            FileInputStream in = new FileInputStream(f);
            try {
                byte[] b = new byte[(int) f.length()];
                int off = 0;
                while (off < b.length) {
                    int n = in.read(b, off, b.length - off);
                    if (n < 0) break;
                    off += n;
                }
                return new JSONObject(new String(b, 0, off, StandardCharsets.UTF_8));
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** How many entries of a list were not there in the last read. */
    private static int fresh(JSONObject before, JSONObject now, String key) {
        if (before == null || now == null) return 0;
        Set<String> had = new HashSet<>();
        JSONArray a = before.optJSONArray(key);
        if (a != null) for (int i = 0; i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x != null) had.add(x.optString("id"));
        }
        int n = 0;
        JSONArray b = now.optJSONArray(key);
        if (b != null) for (int i = 0; i < b.length(); i++) {
            JSONObject x = b.optJSONObject(i);
            if (x != null && !x.optBoolean("done") && !had.contains(x.optString("id"))) n++;
        }
        return n;
    }

    private void notify(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CH, "MYJYSK zadaci i vijesti", NotificationManager.IMPORTANCE_DEFAULT));
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("open", "news");
        PendingIntent pi = PendingIntent.getActivity(this, 3, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_mono)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        nm.notify(3, n);
    }
}
