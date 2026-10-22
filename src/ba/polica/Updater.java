package ba.polica;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Updates the app from its own repository: reads dist/version.json, downloads dist/Polica.apk, checks the
 * SHA-256 and that the file is signed with the same key as this app, then hands it to Android's installer
 * (the system asks the user once to confirm). Nothing is installed without that confirmation.
 */
final class Updater {
    interface Listener {
        /** state: none | downloading | ready | permission | error; called on a worker thread */
        void on(JSONObject state);
    }

    private final Context ctx;
    private final String base;
    private volatile boolean busy;

    Updater(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        String repo = ctx.getString(R.string.update_repo);
        this.base = repo.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
            ? "https://raw.githubusercontent.com/" + repo + "/main/dist/" : null;
    }

    private File dir() {
        File d = new File(ctx.getCacheDir(), "update");
        d.mkdirs();
        return d;
    }

    private int installedCode() {
        try {
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return Integer.MAX_VALUE;
        }
    }

    private static JSONObject o(String state) {
        JSONObject j = new JSONObject();
        try {
            j.put("state", state);
        } catch (Exception ignored) {
        }
        return j;
    }

    /** Looks for a newer version and, when download is true, fetches it. Runs on its own thread. */
    void check(final boolean download, final Listener l) {
        if (base == null) {
            l.on(o("none"));
            return;
        }
        if (busy) return;
        busy = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    run0(download, l);
                } catch (Exception e) {
                    JSONObject j = o("error");
                    try {
                        j.put("msg", String.valueOf(e.getMessage()));
                    } catch (Exception ignored) {
                    }
                    l.on(j);
                } finally {
                    busy = false;
                }
            }
        }, "polica-update").start();
    }

    private void run0(boolean download, Listener l) throws Exception {
        JSONObject v = new JSONObject(new String(get(base + "version.json?t=" + System.currentTimeMillis(), null, null, 0), "UTF-8"));
        int code = v.getInt("code");
        if (code <= installedCode()) {
            l.on(o("none"));
            return;
        }
        String sha = v.getString("sha256").toLowerCase();
        long size = v.getLong("size");
        JSONObject info = o("available");
        info.put("code", code);
        info.put("name", v.optString("name"));
        info.put("notes", v.optString("notes"));
        File apk = new File(dir(), "Polica-" + code + ".apk");
        if (apk.isFile() && apk.length() == size && sha.equals(sha256(apk)) && verify(apk, code)) {
            info.put("state", "ready");
            l.on(info);
            return;
        }
        if (!download) {
            l.on(info);
            return;
        }
        for (File f : dir().listFiles()) if (!f.equals(apk)) f.delete();
        info.put("state", "downloading");
        info.put("pct", 0);
        l.on(info);
        File tmp = new File(dir(), "download.part");
        get(base + "Polica.apk?t=" + System.currentTimeMillis(), tmp, new Progress(info, size, l), size);
        if (tmp.length() != size || !sha.equals(sha256(tmp))) {
            tmp.delete();
            throw new Exception("kontrolna suma ne odgovara");
        }
        if (!tmp.renameTo(apk) || !verify(apk, code)) {
            apk.delete();
            throw new Exception("datoteka nije potpisana istim ključem");
        }
        info.put("state", "ready");
        l.on(info);
    }

    private static final class Progress {
        final JSONObject info;
        final long size;
        final Listener l;
        long last;

        Progress(JSONObject info, long size, Listener l) {
            this.info = info;
            this.size = size;
            this.l = l;
        }

        void at(long n) {
            long now = SystemClock.uptimeMillis();
            if (now - last < 400 && n < size) return;
            last = now;
            try {
                info.put("pct", size > 0 ? (int) (n * 100 / size) : 0);
            } catch (Exception ignored) {
            }
            l.on(info);
        }
    }

    /** GET with redirects; the body goes to dst when given (with progress), else it is returned (max 64 KB). */
    private byte[] get(String url, File dst, Progress p, long expect) throws Exception {
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setRequestProperty("User-Agent", "Polica");
            c.setRequestProperty("Cache-Control", "no-cache");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                if (!url.startsWith("https://")) throw new Exception("nije https");
                c.disconnect();
                continue;
            }
            if (code != 200) throw new Exception("HTTP " + code);
            InputStream in = c.getInputStream();
            try {
                byte[] buf = new byte[16384];
                if (dst == null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        bo.write(buf, 0, n);
                        if (bo.size() > 65536) throw new Exception("prevelik odgovor");
                    }
                    return bo.toByteArray();
                }
                OutputStream out = new FileOutputStream(dst);
                try {
                    long total = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        total += n;
                        if (expect > 0 && total > expect + 1024) throw new Exception("veći od očekivanog");
                        if (p != null) p.at(total);
                    }
                } finally {
                    out.close();
                }
                return null;
            } finally {
                in.close();
                c.disconnect();
            }
        }
        throw new Exception("previše preusmjeravanja");
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        InputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        } finally {
            in.close();
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** The file must be this app (same package), the announced version, and signed with the same key. */
    private boolean verify(File apk, int code) {
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo mine = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            PackageInfo theirs = pm.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (theirs == null || !ctx.getPackageName().equals(theirs.packageName) || theirs.versionCode != code) return false;
            if (mine.signingInfo == null || theirs.signingInfo == null) return false;
            Signature[] a = mine.signingInfo.getApkContentsSigners();
            Signature[] b = theirs.signingInfo.getApkContentsSigners();
            return a.length > 0 && Arrays.equals(a, b);
        } catch (Exception e) {
            return false;
        }
    }

    /** Hands the downloaded file to Android's installer. Returns "ok", "permission" or "none". */
    String install() {
        try {
            File best = null;
            int bestCode = installedCode();
            File[] fs = dir().listFiles();
            if (fs != null) {
                for (File f : fs) {
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("Polica-(\\d+)\\.apk").matcher(f.getName());
                    if (m.matches() && Integer.parseInt(m.group(1)) > bestCode && verify(f, Integer.parseInt(m.group(1)))) {
                        best = f;
                        bestCode = Integer.parseInt(m.group(1));
                    }
                }
            }
            if (best == null) return "none";
            if (!ctx.getPackageManager().canRequestPackageInstalls()) {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return "permission";
            }
            PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            sp.setAppPackageName(ctx.getPackageName());
            int id = pi.createSession(sp);
            PackageInstaller.Session s = pi.openSession(id);
            try {
                InputStream in = new FileInputStream(best);
                OutputStream out = s.openWrite("polica", 0, best.length());
                try {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    s.fsync(out);
                } finally {
                    in.close();
                    out.close();
                }
                Intent ri = new Intent(ctx, UpdateReceiver.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(ctx, id, ri, flags).getIntentSender());
            } finally {
                s.close();
            }
            return "ok";
        } catch (Exception e) {
            return "error";
        }
    }
}
