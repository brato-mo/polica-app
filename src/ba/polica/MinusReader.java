package ba.polica;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Reads the store's minus list from StoreFront in a hidden WebView with the app's own sign-in (assets/minus-reader.js).
 * Only reads. Answer: how = ok (items), login (StoreFront wants a sign-in) or error. Must be started on the main thread.
 */
final class MinusReader {
    interface Callback {
        void done(String how, JSONArray items);
    }

    private MinusReader() {
    }

    static void run(Context ctx, ViewGroup parent, Callback cb) {
        try {
            run0(ctx, parent, cb);
        } catch (Throwable e) {
            cb.done("error", null);
        }
    }

    private static void run0(Context ctx, final ViewGroup parent, final Callback cb) throws Exception {
        final Handler ui = new Handler(Looper.getMainLooper());
        final String host = new StringBuilder(ctx.getString(R.string.storefront_host)).reverse().toString();
        InputStream in = ctx.getAssets().open("minus-reader.js");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        final String script = bo.toString("UTF-8");
        final WebView w = new WebView(ctx.getApplicationContext());
        WebSettings st = w.getSettings();
        st.setJavaScriptEnabled(true);
        st.setDomStorageEnabled(true);
        st.setAllowFileAccess(false);
        st.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        w.setAlpha(0f);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"https".equals(r.getUrl().getScheme());
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                AutoLogin.onPage(v.getContext(), v, url); // the session ran out: sign in again with the kept login
            }
        });
        if (parent != null) parent.addView(w, new ViewGroup.LayoutParams(1, 1));
        w.loadUrl("https://" + host + "/ui/");
        final long t0 = System.currentTimeMillis();
        final boolean[] over = {false};
        final String[] injectedAt = {null};
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() {
            @Override
            public void run() {
                if (over[0]) return;
                if (System.currentTimeMillis() - t0 > 40000) {
                    String u = w.getUrl();
                    boolean away = u != null && !host.equals(Uri.parse(u).getHost());
                    finish(away ? "login" : "error", null);
                    return;
                }
                String u = w.getUrl();
                boolean on = false;
                try {
                    on = u != null && host.equals(Uri.parse(u).getHost()) && w.getProgress() >= 100;
                } catch (Exception ignored) {
                }
                if (on) {
                    if (!u.equals(injectedAt[0])) {
                        injectedAt[0] = u;
                        w.evaluateJavascript(script, null);
                    } else {
                        w.evaluateJavascript("JSON.stringify(window.__ml||null)", new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String v) {
                                if (over[0]) return;
                                try {
                                    Object a = new JSONTokener(v).nextValue();
                                    if (!(a instanceof String)) return;
                                    Object b = new JSONTokener((String) a).nextValue();
                                    if (!(b instanceof JSONObject)) return;
                                    JSONObject o = (JSONObject) b;
                                    String state = o.optString("state");
                                    if ("ok".equals(state)) finish("ok", clean(o.optJSONArray("items")));
                                    else if ("login".equals(state) || "error".equals(state)) finish(state, null);
                                } catch (Exception ignored) {
                                }
                            }
                        });
                    }
                }
                ui.postDelayed(tick[0], 700);
            }

            private void finish(String how, JSONArray items) {
                if (over[0]) return;
                over[0] = true;
                try {
                    if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
                    w.destroy();
                } catch (Exception ignored) {
                }
                CookieManager.getInstance().flush();
                cb.done(how, items);
            }
        };
        ui.postDelayed(tick[0], 1500);
    }

    private static String cut(String s, int max) {
        s = s == null ? "" : s.trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** Only the shape the app needs, from untrusted page data. */
    private static JSONArray clean(JSONArray in) {
        JSONArray out = new JSONArray();
        if (in == null) return out;
        for (int i = 0; i < in.length() && out.length() < 500; i++) {
            JSONObject r = in.optJSONObject(i);
            if (r == null || !r.optString("num").matches("\\d{7}")) continue;
            try {
                JSONObject c = new JSONObject();
                c.put("num", r.optString("num"));
                c.put("name", cut(r.optString("name"), 120));
                c.put("st", cut(r.optString("st"), 3).replaceAll("[^0-9]", ""));
                c.put("qty", Math.max(-99999, Math.min(99999, r.optDouble("qty", 0))));
                c.put("blocked", Math.max(-99999, Math.min(99999, r.optDouble("blocked", 0))));
                c.put("unit", cut(r.optString("unit"), 6));
                c.put("group", cut(r.optString("group"), 60));
                JSONArray subs = new JSONArray();
                JSONArray s = r.optJSONArray("subs");
                for (int k = 0; s != null && k < s.length() && k < 3; k++) if (s.optString(k).matches("\\d{7}")) subs.put(s.optString(k));
                c.put("subs", subs);
                out.put(c);
            } catch (Exception ignored) {
            }
        }
        return out;
    }
}
