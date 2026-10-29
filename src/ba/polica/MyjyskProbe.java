package ba.polica;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * Reads MYJYSK in a hidden WebView with the app's own sign-in. Answer: ok + data, login (the employee has to sign in
 * again, on the visible screen), error, or off (no MYJYSK address in this build). Must be started on the main thread.
 */
final class MyjyskProbe {
    interface Callback {
        void done(String how, JSONObject data);
    }

    private static final long TIMEOUT_MS = 45000;
    private static final long AWAY_MS = 12000; // this long on a sign-in page: the employee has to sign in

    private MyjyskProbe() {
    }

    static void run(Context ctx, ViewGroup parent, Callback cb) {
        try {
            if (!MyjyskReader.enabled(ctx)) {
                cb.done("off", null);
                return;
            }
            run0(ctx, parent, cb);
        } catch (Throwable e) {
            cb.done("error", null);
        }
    }

    private static void run0(Context ctx, final ViewGroup parent, final Callback cb) {
        final Handler ui = new Handler(Looper.getMainLooper());
        final MyjyskReader reader = new MyjyskReader(ctx);
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
        final boolean[] over = {false};
        final boolean[] reloaded = {false};
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() {
            @Override
            public void run() {
                if (over[0]) return;
                if (System.currentTimeMillis() - t0 > TIMEOUT_MS) {
                    finish("error", null);
                    return;
                }
                reader.poll(w, new MyjyskReader.Result() {
                    @Override
                    public void on(String state, JSONObject data) {
                        if (over[0]) return;
                        long now = System.currentTimeMillis();
                        if ("away".equals(state)) {
                            if (w.getProgress() < 100) awaySince[0] = 0;
                            else if (awaySince[0] == 0) awaySince[0] = now;
                            else if (now - awaySince[0] > AWAY_MS) finish("login", null);
                            return;
                        }
                        awaySince[0] = 0;
                        if ("ok".equals(state)) finish("ok", data);
                        else if ("login".equals(state)) {
                            if (!reloaded[0]) {
                                // the session may only need the start page to sign in again by itself
                                reloaded[0] = true;
                                reader.reset();
                                w.loadUrl(reader.home());
                            } else {
                                finish("login", null);
                            }
                        } else if ("error".equals(state)) finish("error", null);
                    }
                });
                ui.postDelayed(tick[0], 900);
            }

            private void finish(String how, JSONObject data) {
                if (over[0]) return;
                over[0] = true;
                try {
                    if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
                    w.destroy();
                } catch (Exception ignored) {
                }
                CookieManager.getInstance().flush();
                cb.done(how, data);
            }
        };
        ui.postDelayed(tick[0], 1500);
    }
}
