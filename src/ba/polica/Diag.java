package ba.polica;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Diagnostics without secrets: every line is cleaned (passwords, tokens, e-mail addresses, long digit strings that
 * could be employee or card numbers, long base64 strings) and cut short before it goes to the Android log or to the
 * small local file data/diag.log (newest lines kept, at most about 64 KB). Article numbers (7 digits) stay, they are
 * what a fault is usually about. Nothing leaves the phone unless the employee copies the file himself.
 */
final class Diag {
    private static final String TAG = "Polica";
    private static final int MAX_LINE = 300;
    private static final long MAX_FILE = 64 * 1024;
    private static final Pattern SECRET = Pattern.compile("(?i)(pass(word)?|lozinka|token|secret|authorization|cookie|session)([\"'\\s:=]+)[^\\s,;&\"'}]+");
    private static final Pattern MAIL = Pattern.compile("[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+");
    private static final Pattern B64 = Pattern.compile("[A-Za-z0-9+/_=-]{24,}");
    // 6 digits (employee numbers) and 8 or more (cards, accounts, phones); 7 digits are article numbers and stay
    private static final Pattern DIGITS = Pattern.compile("(?<!\\d)(\\d{6}|\\d{8,})(?!\\d)");

    private Diag() {
    }

    static String clean(String s) {
        if (s == null) return "";
        s = s.replaceAll("[\\r\\n\\t]+", " ");
        s = SECRET.matcher(s).replaceAll("$1$3***");
        s = MAIL.matcher(s).replaceAll("***@***");
        s = B64.matcher(s).replaceAll("***");
        s = DIGITS.matcher(s).replaceAll("***");
        return s.length() > MAX_LINE ? s.substring(0, MAX_LINE) + "…" : s;
    }

    static void w(Context ctx, String what, Throwable e) {
        String line = clean(what + (e == null ? "" : ": " + e.getClass().getSimpleName() + " " + e.getMessage()));
        Log.w(TAG, line);
        file(ctx, "W", line);
    }

    /** A short note for the local file only (how long a StoreFront job took, ...), cleaned like the rest. */
    static void i(Context ctx, String what) {
        file(ctx, "I", clean(what));
    }

    /** A console message of the app's own page: only warnings and errors are kept in a release build. */
    static void console(Context ctx, String level, String msg, String src, int line) {
        boolean bad = "ERROR".equals(level) || "WARNING".equals(level);
        if (!bad && !BuildConfigLite.debug(ctx)) return;
        String s = clean(msg + " (" + shortSrc(src) + ":" + line + ")");
        if (bad) {
            Log.w(TAG, s);
            file(ctx, level.substring(0, 1), s);
        } else {
            Log.d(TAG, s);
        }
    }

    private static String shortSrc(String src) {
        if (src == null) return "";
        int i = src.lastIndexOf('/');
        return i >= 0 ? src.substring(i + 1) : src;
    }

    private static synchronized void file(Context ctx, String level, String line) {
        if (ctx == null) return;
        try {
            File d = new File(ctx.getFilesDir(), "data");
            if (!d.isDirectory()) d.mkdirs();
            File f = new File(d, "diag.log");
            if (f.length() > MAX_FILE) trim(f);
            String stamp = new SimpleDateFormat("dd.MM. HH:mm:ss", Locale.ROOT).format(new Date());
            FileOutputStream out = new FileOutputStream(f, true);
            try {
                out.write((stamp + " " + level + " " + line + "\n").getBytes(StandardCharsets.UTF_8));
            } finally {
                out.close();
            }
        } catch (Exception ignored) {
        }
    }

    /** Keeps the newer half of the file. */
    private static void trim(File f) throws Exception {
        RandomAccessFile r = new RandomAccessFile(f, "r");
        byte[] keep;
        try {
            long from = r.length() / 2;
            r.seek(from);
            keep = new byte[(int) (r.length() - from)];
            r.readFully(keep);
        } finally {
            r.close();
        }
        int nl = 0;
        while (nl < keep.length && keep[nl] != '\n') nl++;
        byte[] rest = new byte[Math.max(0, keep.length - nl - 1)];
        System.arraycopy(keep, Math.min(keep.length, nl + 1), rest, 0, rest.length);
        MainActivity.writeAtomic(f, rest);
    }

    /** Whether the installed app is a debug build (never true for builds made by build.sh, which are release). */
    static final class BuildConfigLite {
        static boolean debug(Context ctx) {
            try {
                return (ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
