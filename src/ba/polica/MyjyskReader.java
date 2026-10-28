package ba.polica;

import android.content.Context;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Reads MYJYSK (the company's task and news site) in a WebView that carries the employee's own sign-in: injects
 * assets/myjysk-reader.js into the MYJYSK page and picks up its result. Used by the hidden background read, the
 * sign-in screen and the 8:00 job. The address is not part of the source (R.string.myjysk_host, from the build).
 */
final class MyjyskReader {
    static final String HOME = "/ui/dashboards/177";

    interface Result {
        /** state: ok (data set), login, error, busy (still reading), away (not on MYJYSK: a sign-in page, say) */
        void on(String state, JSONObject data);
    }

    final String host;
    private final String script;
    private String injectedUrl;
    private int nulls;

    MyjyskReader(Context c) {
        host = hostOf(c);
        script = asset(c, "myjysk-reader.js");
    }

    static String hostOf(Context c) {
        try {
            return new StringBuilder(c.getString(R.string.myjysk_host)).reverse().toString().trim();
        } catch (Exception e) {
            return "";
        }
    }

    static boolean enabled(Context c) {
        return hostOf(c).contains(".");
    }

    String home() {
        return "https://" + host + HOME;
    }

    boolean onHost(String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            return "https".equals(u.getScheme()) && host.equals(u.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /** The next read is started from scratch (after a reload). */
    void reset() {
        injectedUrl = null;
        nulls = 0;
    }

    /** One look at the page; call it every second or so on the main thread. */
    void poll(WebView w, final Result r) {
        String url = w.getUrl();
        if (!onHost(url) || w.getProgress() < 100) {
            r.on("away", null);
            return;
        }
        Uri u = Uri.parse(url);
        if (u.getPath() == null || !u.getPath().startsWith("/ui/")) {
            r.on("away", null); // MYJYSK's own sign-in page, or on the way to it
            return;
        }
        if (!url.equals(injectedUrl)) {
            injectedUrl = url;
            nulls = 0;
            w.evaluateJavascript(script, null);
            r.on("busy", null);
            return;
        }
        w.evaluateJavascript("JSON.stringify(window.__mjr||null)", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                JSONObject o = parse(v);
                if (o == null) {
                    if (++nulls > 3) injectedUrl = null; // the page was replaced: inject again
                    r.on("busy", null);
                    return;
                }
                String st = o.optString("state");
                if ("ok".equals(st)) r.on("ok", clean(o));
                else if ("login".equals(st) || "error".equals(st)) r.on(st, null);
                else r.on("busy", null);
            }
        });
    }

    private static JSONObject parse(String v) {
        if (v == null || "null".equals(v)) return null;
        try {
            Object a = new JSONTokener(v).nextValue();
            if (!(a instanceof String)) return null;
            Object b = new JSONTokener((String) a).nextValue();
            return b instanceof JSONObject ? (JSONObject) b : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Only the lists the app shows, with a cap on their length; the texts are escaped where they are shown. */
    private static JSONObject clean(JSONObject in) {
        JSONObject o = new JSONObject();
        try {
            o.put("my", cap(in.optJSONArray("my"), 100));
            o.put("loc", cap(in.optJSONArray("loc"), 200));
            o.put("news", cap(in.optJSONArray("news"), 40));
            o.put("sys", cap(in.optJSONArray("sys"), 10));
            o.put("locTotal", in.optInt("locTotal"));
            o.put("newsTotal", in.optInt("newsTotal"));
        } catch (Exception ignored) {
        }
        return o;
    }

    private static JSONArray cap(JSONArray a, int max) {
        JSONArray out = new JSONArray();
        if (a == null) return out;
        for (int i = 0; i < a.length() && out.length() < max; i++) {
            JSONObject x = a.optJSONObject(i);
            if (x != null) out.put(x);
        }
        return out;
    }

    private static String asset(Context c, String name) {
        try {
            InputStream in = c.getAssets().open(name);
            try {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                return new String(b.toByteArray(), StandardCharsets.UTF_8);
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return "";
        }
    }
}
