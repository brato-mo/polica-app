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
 * Sends the minus-list corrections the employee confirmed, with the SAP HR number and password they typed in the app
 * for this one sending (never kept). Runs assets/minus-apply.js in a hidden StoreFront page, which does what
 * StoreFront's own approve dialog does. Answer: the script's result (state ok with sent/skipped, or error).
 * Must be started on the main thread.
 */
final class MinusApply {
    interface Callback {
        void done(JSONObject result);

        /** The step the page reached (start, user, minus, adjust), as it changes. */
        void step(String step);
    }

    private MinusApply() {
    }

    static void run(Context ctx, ViewGroup parent, String user, String pass, JSONArray items, boolean adjustOnly, Callback cb) {
        try {
            run0(ctx, parent, user, pass, items, adjustOnly, cb);
        } catch (Throwable e) {
            cb.done(err("start"));
        }
    }

    private static JSONObject err(String why) {
        JSONObject o = new JSONObject();
        try {
            o.put("state", "error");
            o.put("why", why);
        } catch (Exception ignored) {
        }
        return o;
    }

    static JSONObject unknown(String step, String why) {
        JSONObject o = new JSONObject();
        try {
            o.put("state", "unknown");
            o.put("step", step == null || step.isEmpty() ? "start" : step);
            o.put("why", why);
        } catch (Exception ignored) {
        }
        return o;
    }

    private static void run0(Context ctx, final ViewGroup parent, String user, String pass, JSONArray items, boolean adjustOnly, final Callback cb) throws Exception {
        final Handler ui = new Handler(Looper.getMainLooper());
        final String host = new StringBuilder(ctx.getString(R.string.storefront_host)).reverse().toString();
        InputStream in = ctx.getAssets().open("minus-apply.js");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        JSONObject input = new JSONObject();
        input.put("user", user);
        input.put("pass", pass);
        input.put("items", items);
        input.put("mode", adjustOnly ? "adjust" : "both");
        if (Sandbox.on(ctx)) input.put("sim", Sandbox.sim(ctx)); // test build: the outcome is played, nothing is sent
        final String[] script = {"window.__mx=null;window.__mxIn=" + input + ";" + bo.toString("UTF-8")};
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
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"https".equals(r.getUrl().getScheme());
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                AutoLogin.onPage(v.getContext(), v, url);
            }
        });
        if (parent != null) parent.addView(w, new ViewGroup.LayoutParams(1, 1));
        w.loadUrl("https://" + host + "/ui/");
        final long t0 = System.currentTimeMillis();
        final boolean[] over = {false};
        final boolean[] injected = {false};
        final String[] lastStep = {"start"};
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() {
            @Override
            public void run() {
                if (over[0]) return;
                // a sending that started is waited for longer: it must not be cut off halfway
                if (System.currentTimeMillis() - t0 > (injected[0] ? 120000 : 45000)) {
                    if (!injected[0]) {
                        finish(err("login")); // the page never opened: nothing was sent
                        return;
                    }
                    timeout();
                    return;
                }
                String u = w.getUrl();
                boolean on = false;
                try {
                    on = u != null && host.equals(Uri.parse(u).getHost()) && Uri.parse(u).getPath() != null
                        && Uri.parse(u).getPath().startsWith("/ui") && w.getProgress() >= 100;
                } catch (Exception ignored) {
                }
                if (on && !injected[0]) {
                    injected[0] = true;
                    w.evaluateJavascript(script[0], null);
                    script[0] = null; // the password is not kept here either
                } else if (injected[0]) {
                    w.evaluateJavascript("JSON.stringify(window.__mx||null)", new ValueCallback<String>() {
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
                                String st = o.optString("step");
                                if (!st.isEmpty() && !st.equals(lastStep[0])) {
                                    lastStep[0] = st;
                                    cb.step(st);
                                }
                                if ("ok".equals(state) || "error".equals(state) || "unknown".equals(state)) finish(o);
                            } catch (Exception ignored) {
                            }
                        }
                    });
                }
                ui.postDelayed(tick[0], 700);
            }

            /**
             * The sending ran out of time after it had started: its outcome is not known (a request may have reached
             * StoreFront). One last look at the page, then "unknown" with the step it had reached. Never "nothing sent".
             */
            private void timeout() {
                final Runnable last = new Runnable() {
                    @Override
                    public void run() {
                        finish(unknown(lastStep[0], "timeout"));
                    }
                };
                ui.postDelayed(last, 5000);
                try {
                    w.evaluateJavascript("JSON.stringify(window.__mx||null)", new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            ui.removeCallbacks(last);
                            try {
                                Object a = new JSONTokener(v).nextValue();
                                Object b = a instanceof String ? new JSONTokener((String) a).nextValue() : null;
                                if (b instanceof JSONObject) {
                                    JSONObject o = (JSONObject) b;
                                    String state = o.optString("state");
                                    if ("ok".equals(state) || "error".equals(state) || "unknown".equals(state)) {
                                        finish(o);
                                        return;
                                    }
                                    finish(unknown(o.optString("step", lastStep[0]), "timeout"));
                                    return;
                                }
                            } catch (Exception ignored) {
                            }
                            finish(unknown(lastStep[0], "timeout"));
                        }
                    });
                } catch (Exception e) {
                    ui.removeCallbacks(last);
                    finish(unknown(lastStep[0], "timeout"));
                }
            }

            private void finish(JSONObject o) {
                if (over[0]) return;
                over[0] = true;
                script[0] = null;
                try {
                    if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
                    w.destroy();
                } catch (Exception ignored) {
                }
                CookieManager.getInstance().flush();
                cb.done(o);
            }
        };
        ui.postDelayed(tick[0], 1500);
    }
}
