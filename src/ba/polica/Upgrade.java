package ba.polica;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;

/**
 * A copy of the app's own records before a new version first runs: the JSON files of files/data (list of planograms,
 * favorites and recent, settings, Minus lista state, orders, news) go to files/backup/<old version code>/. Not copied,
 * because an update never rewrites them: the planogram PDFs (files/plans), their reads (plan-<id>.json, which can
 * always be made again from the PDFs), pictures, and the sign-in (Keystore). The two
 * newest copies are kept. Postavke → Podaci can put a copy back.
 */
final class Upgrade {
    private static final int KEEP = 2;
    private static final java.util.Comparator<File> NEWEST = new java.util.Comparator<File>() {
        @Override
        public int compare(File x, File y) {
            return Long.compare(y.lastModified(), x.lastModified());
        }
    };

    private Upgrade() {
    }

    static int code(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    /** At start: the first run of a newer version copies the records as the older version left them. */
    static void snapshot(Context c) {
        SharedPreferences p = c.getSharedPreferences("upgrade", Context.MODE_PRIVATE);
        int now = code(c);
        int last = p.getInt("code", 0);
        if (last == now) return;
        File data = new File(c.getFilesDir(), "data");
        String[] names = data.list();
        // 0 = the version before 1.58, which did not note itself: named "prije-<this version>"
        if (now > last && names != null && names.length > 0) {
            File dst = new File(new File(c.getFilesDir(), "backup"), last > 0 ? String.valueOf(last) : "prije-" + now);
            if (copyDir(data, dst)) prune(new File(c.getFilesDir(), "backup"));
            else Diag.w(c, "backup failed", null);
        }
        p.edit().putInt("code", now).apply();
    }

    private static boolean copyDir(File from, File to) {
        File tmp = new File(to.getParentFile(), to.getName() + ".part");
        delete(tmp);
        if (!tmp.mkdirs()) return false;
        File[] files = from.listFiles();
        if (files == null) return false;
        try {
            for (File f : files) {
                // the planogram reads (plan-<id>.json, large) are not copied: an update never rewrites them and they
                // can always be read again from the PDFs, which stay in files/plans
                if (!f.isFile() || !f.getName().endsWith(".json") || f.getName().startsWith("plan-")) continue;
                copy(f, new File(tmp, f.getName()));
            }
        } catch (Exception e) {
            delete(tmp);
            return false;
        }
        delete(to);
        return tmp.renameTo(to);
    }

    private static void copy(File a, File b) throws Exception {
        InputStream in = new FileInputStream(a);
        try {
            OutputStream out = new FileOutputStream(b);
            try {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                ((FileOutputStream) out).getFD().sync();
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    private static void delete(File f) {
        if (f.isDirectory()) {
            File[] k = f.listFiles();
            if (k != null) for (File x : k) delete(x);
        }
        f.delete();
    }

    private static void prune(File dir) {
        File[] all = dir.listFiles();
        if (all == null || all.length <= KEEP) return;
        Arrays.sort(all, NEWEST);
        for (int i = KEEP; i < all.length; i++) if (!all[i].getName().endsWith(".part")) delete(all[i]);
    }

    /** The copies there are, newest first: [{name, at, files, bytes}] as JSON. */
    static String list(Context c) {
        org.json.JSONArray out = new org.json.JSONArray();
        File[] all = new File(c.getFilesDir(), "backup").listFiles();
        if (all == null) return out.toString();
        Arrays.sort(all, NEWEST);
        for (File d : all) {
            if (!d.isDirectory() || d.getName().endsWith(".part")) continue;
            File[] fs = d.listFiles();
            long bytes = 0;
            int n = 0;
            if (fs != null) for (File f : fs) { bytes += f.length(); n++; }
            try {
                out.put(new org.json.JSONObject().put("name", d.getName()).put("at", d.lastModified()).put("files", n).put("bytes", bytes));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    /**
     * Puts a copy back: its files replace those of files/data with the same names (each through a temporary file).
     * The current files are first copied to backup/vraceno-<time>, so this can be undone too. The sending record
     * (minus-op.json) is never replaced: an open sending stays open.
     */
    static boolean restore(Context c, String name) {
        if (name == null || !name.matches("[A-Za-z0-9-]{1,40}")) return false;
        File src = new File(new File(c.getFilesDir(), "backup"), name);
        File data = new File(c.getFilesDir(), "data");
        File[] fs = src.listFiles();
        if (fs == null || fs.length == 0) return false;
        if (!copyDir(data, new File(new File(c.getFilesDir(), "backup"), "vraceno-" + System.currentTimeMillis() / 1000))) return false;
        try {
            for (File f : fs) {
                if (!f.getName().endsWith(".json") || OpLog.FILE.equals(f.getName())) continue;
                File tmp = new File(data, f.getName() + ".tmp");
                copy(f, tmp);
                if (!tmp.renameTo(new File(data, f.getName()))) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
