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

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Runs one job of assets/myjysk-ar.js in a hidden WebView with the employee's own MYJYSK sign-in: reading the AR
 * form, or sending the answers he chose. Answer: ok + result, login (he has to sign in again), error (+ how far it
 * got). A job that sends is injected exactly once, never again on a reload, so a visit is never made twice.
 */
final class MyjyskTask {
    interface Callback {
        void done(JSONObject answer);
    }

    private static final long TIMEOUT_MS = 90000;
    private static final long AWAY_MS = 12000; // this long on a sign-in page: the employee has to sign in

    private MyjyskTask() {
    }

    static void run(Context ctx, ViewGroup parent, String argJson, Callback cb) {
        try {
            if (!MyjyskReader.enabled(ctx)) {
                cb.done(answer("off", null));
                return;
            }
            JSONObject arg = new JSONObject(argJson);
            run0(ctx, parent, arg, cb);
        } catch (Throwable e) {
            cb.done(answer("error", null));
        }
    }

    private static JSONObject answer(String how, JSONObject from) {
        JSONObject o = new JSONObject();
        try {
            o.put("how", how);
            if (from != null) {
                if (from.has("res")) o.put("res", from.get("res"));
                o.put("err", from.optString("err"));
                o.put("step", from.optString("step"));
                o.put("id", from.optLong("id"));
                o.put("done", from.optInt("done"));
            }
        } catch (Exception ignored) {
        }
        return o;
    }

    private static void run0(Context ctx, final ViewGroup parent, JSONObject arg, final Callback cb) {
        if (Sandbox.on(ctx)) {
            try {
                arg.put("dry", true); // test build: the script plays a sending instead of making it
            } catch (Exception ignored) {
            }
        }
        final Handler ui = new Handler(Looper.getMainLooper());
        final MyjyskReader reader = new MyjyskReader(ctx);
        final boolean sends = "send".equals(arg.optString("mode"));
        final String script = "window.__mjt=null;window.__mjArg=" + JSONObject.quote(arg.toString()) + ";window.__mjArg=JSON.parse(window.__mjArg);" + asset(ctx, "myjysk-ar.js");
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
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView sbView, android.webkit.WebResourceRequest sbReq) {
                return Sandbox.guard(sbView.getContext(), sbReq); // test builds: nothing that writes leaves the phone
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                AutoLogin.onPage(v.getContext(), v, url); // the session ran out: sign in again with the kept login
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"https".equals(r.getUrl().getScheme());
            }
        });
        if (parent != null) parent.addView(w, new ViewGroup.LayoutParams(1, 1));
        w.loadUrl(reader.home());
        final long t0 = System.currentTimeMillis();
        final long[] awaySince = {0};
        final long[] readySince = {0};
        final boolean[] over = {false};
        final boolean[] injected = {false};
        final int[] nulls = {0};
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() {
            @Override
            public void run() {
                if (over[0]) return;
                long now = System.currentTimeMillis();
                if (now - t0 > TIMEOUT_MS) {
                    JSONObject x = new JSONObject();
                    try {
                        x.put("err", "timeout");
                    } catch (Exception ignored) {
                    }
                    finish("error", x);
                    return;
                }
                String url = w.getUrl();
                boolean onMj = reader.onHost(url) && w.getProgress() >= 100 && url != null && Uri.parse(url).getPath() != null && Uri.parse(url).getPath().startsWith("/ui/");
                if (!injected[0]) {
                    if (!onMj) {
                        readySince[0] = 0;
                        if (w.getProgress() < 100) awaySince[0] = 0;
                        else if (awaySince[0] == 0) awaySince[0] = now;
                        else if (now - awaySince[0] > AWAY_MS) finish("login", null);
                    } else {
                        awaySince[0] = 0;
                        if (readySince[0] == 0) readySince[0] = now;
                        else if (now - readySince[0] > 1200) { // the page has settled (no redirect to the sign-in)
                            injected[0] = true;
                            w.evaluateJavascript(script, null);
                        }
                    }
                    ui.postDelayed(tick[0], 700);
                    return;
                }
                w.evaluateJavascript("JSON.stringify(window.__mjt||null)", new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        if (over[0]) return;
                        JSONObject o = parse(v);
                        if (o == null) {
                            // the page was replaced after the job started. Reading is simply started again; sending is
                            // not (it may have made the visit already): the employee looks in MYJYSK.
                            if (++nulls[0] > 4) {
                                if (sends) {
                                    JSONObject x = new JSONObject();
                                    try {
                                        x.put("err", "lost");
                                    } catch (Exception ignored) {
                                    }
                                    finish("error", x);
                                    return;
                                }
                                injected[0] = false;
                                readySince[0] = 0;
                                nulls[0] = 0;
                            }
                        } else {
                            nulls[0] = 0;
                            String s = o.optString("state");
                            if ("ok".equals(s) || "login".equals(s) || "error".equals(s)) {
                                finish(s, o);
                                return;
                            }
                        }
                        ui.postDelayed(tick[0], 700);
                    }
                });
            }

            private void finish(String how, JSONObject from) {
                if (over[0]) return;
                over[0] = true;
                try {
                    if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
                    w.destroy();
                } catch (Exception ignored) {
                }
                CookieManager.getInstance().flush();
                cb.done(answer(how, from));
            }
        };
        ui.postDelayed(tick[0], 1500);
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
