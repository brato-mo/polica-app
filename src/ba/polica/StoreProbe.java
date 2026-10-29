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

/**
 * Opens the customer-orders page of the store system in a hidden WebView with the app's own sign-in and reports
 * whether it let the employee in, plus the numbers on its tabs ("Aktivan:92,Stigao:45,..."). Reads nothing else.
 * Must be started on the main thread.
 */
final class StoreProbe {
    interface Callback {
        void done(boolean online, String counts);
    }

    private StoreProbe() {
    }

    static void run(Context ctx, final ViewGroup parent, final Callback cb) {
        try {
            run0(ctx, parent, cb);
        } catch (Throwable e) {
            cb.done(false, "");
        }
    }

    private static void run0(Context ctx, final ViewGroup parent, final Callback cb) {
        final Handler ui = new Handler(Looper.getMainLooper());
        final String host = new StringBuilder(ctx.getString(R.string.storefront_host)).reverse().toString();
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
        w.loadUrl("https://" + host + "/ui/legacy-customer-orders");
        final long t0 = System.currentTimeMillis();
        final boolean[] over = {false};
        final String[] last = {""};
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() {
            @Override
            public void run() {
                if (over[0]) return;
                String u = w.getUrl();
                boolean away = false;
                try {
                    away = u != null && !host.equals(Uri.parse(u).getHost()) && w.getProgress() >= 100
                        // on the sign-in page with a kept login: the app signs in by itself, wait for it
                        && !(AutoLogin.ready(w.getContext()) && AutoLogin.isLoginPage(w.getContext(), u) && System.currentTimeMillis() - t0 < 15000);
                } catch (Exception ignored) {
                }
                if (away || System.currentTimeMillis() - t0 > 25000) {
                    finish(false, "");
                    return;
                }
                if (u != null && u.contains(host)) {
                    w.evaluateJavascript("(function(){var t=document.body?document.body.innerText:'';var re=/(Aktivan|Ispunjen|Stigao|Zakasnio) \\((\\d+)\\)/g,m,o=[],s={};"
                        + "while((m=re.exec(t))){if(!s[m[1]]){s[m[1]]=1;o.push(m[1]+':'+m[2]);}}return o.join(',')})()", new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            String c = v == null ? "" : v.replace("\"", "");
                            // all four tabs drawn, or the same answer twice in a row
                            if (c.length() > 0 && (c.split(",").length >= 4 || c.equals(last[0]))) finish(true, c);
                            else last[0] = c;
                        }
                    });
                }
                ui.postDelayed(tick[0], 800);
            }

            private void finish(boolean on, String counts) {
                if (over[0]) return;
                over[0] = true;
                try {
                    if (w.getParent() != null) ((ViewGroup) w.getParent()).removeView(w);
                    w.destroy();
                } catch (Exception ignored) {
                }
                CookieManager.getInstance().flush();
                cb.done(on, counts);
            }
        };
        ui.postDelayed(tick[0], 1500);
    }
}
