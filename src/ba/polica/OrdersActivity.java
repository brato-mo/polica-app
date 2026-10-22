package ba.polica;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.regex.Pattern;

/**
 * Reads the customer orders of the tabs Ispunjen, Stigao, Zakasnio and Aktivan from StoreFront's own Customer
 * Orders page, so the app can say that a scanned article was ordered by a customer. The employee is signed in on
 * StoreFront's page; this only reads what that page shows. The page gets no bridge to the app. Orders that were
 * read before are not opened again (their article lines do not change); the app passes their numbers in.
 */
public class OrdersActivity extends Activity {
    private String host; // from the build (R.string.storefront_host), not part of the source
    private String target;
    static final String EXTRA_KNOWN = "known";
    static final String EXTRA_TABS = "tabs";
    static final String EXTRA_JSON = "json";
    private static final Pattern ORDER_NO = Pattern.compile("#[0-9A-Za-z]{8,30}");
    private static final long POLL_MS = 250;
    private static final long STALL_MS = 90000;

    private WebView web;
    private TextView status;
    private Handler handler;
    private String known = "[]";
    private String tabs = "[\"Ispunjen\",\"Stigao\",\"Zakasnio\",\"Aktivan\"]";
    private String driver;
    private boolean finished;
    private boolean reloaded;
    private boolean injected;
    private int injections;
    private long lastMove;
    private String lastKey = "";
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            check();
            if (!finished) handler.postDelayed(this, POLL_MS);
        }
    };

    private float dp(float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private boolean onOrders(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return host.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/ui/legacy-customer-orders");
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        host = new StringBuilder(getString(R.string.storefront_host)).reverse().toString();
        target = "https://" + host + "/ui/legacy-customer-orders";
        try {
            JSONArray k = new JSONArray(getIntent().getStringExtra(EXTRA_KNOWN));
            JSONArray safe = new JSONArray();
            for (int i = 0; i < k.length() && i < 600; i++) {
                String s = k.optString(i);
                if (ORDER_NO.matcher(s).matches()) safe.put(s);
            }
            known = safe.toString();
        } catch (Exception ignored) {
        }
        try {
            JSONArray t = new JSONArray(getIntent().getStringExtra(EXTRA_TABS));
            JSONArray safe = new JSONArray();
            for (int i = 0; i < t.length(); i++) {
                String s = t.optString(i);
                if (("Ispunjen".equals(s) || "Stigao".equals(s) || "Zakasnio".equals(s) || "Aktivan".equals(s))) safe.put(s);
            }
            if (safe.length() > 0) tabs = safe.toString();
        } catch (Exception ignored) {
        }
        try {
            InputStream in = getAssets().open("orders-driver.js");
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            driver = "window.__polKnown=" + known + ";window.__polTabs=" + tabs + ";" + bo.toString("UTF-8");
        } catch (Exception e) {
            finishWith(null, "error", "driver");
            return;
        }
        // reading takes minutes and stops when the screen goes off
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = dark ? 0xFF0E1014 : 0xFFF3F4F7;
        int ink = dark ? 0xFFEEF1F7 : 0xFF131620;
        int blue = dark ? 0xFF6D8BFF : 0xFF2B50E6;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (!dark) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | 0x00000010);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(bg);
        root.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding((int) dp(8), (int) dp(4), (int) dp(8), (int) dp(4));
        TextView close = new TextView(this);
        close.setText("Prekini");
        close.setTextColor(blue);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        close.setTypeface(Typeface.DEFAULT_BOLD);
        close.setGravity(Gravity.CENTER);
        close.setPadding((int) dp(14), 0, (int) dp(14), 0);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finishWith(null, "cancelled", null);
            }
        });
        TextView title = new TextView(this);
        title.setText("Narudžbe kupaca");
        title.setTextColor(ink);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) dp(44)));
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(new View(this), new LinearLayout.LayoutParams((int) dp(72), (int) dp(44)));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout body = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(dark ? 0xFF121212 : 0xFFFFFFFF);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"https".equals(r.getUrl().getScheme());
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) {
                injected = false; // a new page has none of our script
                showStatus(url);
            }
        });
        body.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        status = new TextView(this);
        status.setTextColor(ink);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setGravity(Gravity.CENTER);
        status.setPadding((int) dp(32), 0, (int) dp(32), 0);
        status.setBackgroundColor(bg);
        status.setText("Čitam narudžbe kupaca…");
        status.setVisibility(View.GONE);
        body.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        handler = new Handler(Looper.getMainLooper());
        lastMove = System.currentTimeMillis();
        web.loadUrl(target);
        handler.postDelayed(poll, POLL_MS);
    }

    private void showStatus(String url) {
        if (status != null) status.setVisibility(onOrders(url) ? View.VISIBLE : View.GONE);
    }

    private void check() {
        if (finished || web == null) return;
        final String url = web.getUrl();
        showStatus(url);
        Uri u = url == null ? null : Uri.parse(url);
        if (!onOrders(url)) {
            lastMove = System.currentTimeMillis(); // signing in takes as long as it takes
            if (u != null && host.equals(u.getHost()) && !reloaded && u.getPath() != null && u.getPath().startsWith("/ui")) {
                reloaded = true;
                web.loadUrl(target);
            }
            return;
        }
        if (!injected) {
            if (injections >= 3) {
                finishWith(null, "error", "reload");
                return;
            }
            injected = true;
            lastTap = 0;
            injections++;
            lastMove = System.currentTimeMillis();
            web.evaluateJavascript(driver, null);
            return;
        }
        web.evaluateJavascript("(function(){var p=window.__pol;return p?JSON.stringify({d:p.done,e:p.err,r:p.read,s:p.seen,m:p.msg,t:p.tap,x:p.expect||0}):''})()",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (finished || value == null) return;
                    try {
                        Object v = new JSONTokener(value).nextValue();
                        if (!(v instanceof String) || ((String) v).isEmpty()) {
                            if (System.currentTimeMillis() - lastMove > 8000) injected = false; // script is gone
                            return;
                        }
                        JSONObject o = new JSONObject((String) v);
                        JSONObject tap = o.optJSONObject("t");
                        if (tap != null && tap.optInt("q") != lastTap) {
                            lastTap = tap.optInt("q");
                            tap(tap.optDouble("x"), tap.optDouble("y"), lastTap);
                        }
                        String key = o.optInt("r") + "/" + o.optInt("s") + "/" + o.optString("m");
                        if (!key.equals(lastKey)) {
                            lastKey = key;
                            lastMove = System.currentTimeMillis();
                        }
                        String msg = "Čitam narudžbe kupaca…";
                        if (o.optInt("s") > 0) msg += "\n" + o.optInt("s") + (o.optInt("x") > 0 ? " od " + o.optInt("x") : "") + " pregledano";
                        if (o.optInt("r") > 0) msg += ", " + o.optInt("r") + " novih otvoreno";
                        status.setText(msg);
                        if (o.optBoolean("d")) {
                            boolean noErr = o.isNull("e") || o.optString("e").isEmpty();
                            collect(noErr ? "ok" : "error", noErr ? "" : o.optString("e"));
                        } else if (System.currentTimeMillis() - lastMove > STALL_MS) {
                            collect("timeout", "");
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
    }

    private int lastTap;

    /** A real touch on the page at (x, y) device pixels; the page's script asked for it, then waits for the answer. */
    private void tap(double x, double y, final int q) {
        if (web == null || x < 0 || y < 0) return;
        long t = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, (float) x, (float) y, 0);
        MotionEvent up = MotionEvent.obtain(t, t + 70, MotionEvent.ACTION_UP, (float) x, (float) y, 0);
        web.dispatchTouchEvent(down);
        web.dispatchTouchEvent(up);
        down.recycle();
        up.recycle();
        web.evaluateJavascript("window.__pol&&(window.__pol.tapDone=" + q + ")", null);
    }

    private boolean collecting;

    private void collect(final String how, final String err) {
        if (collecting || finished) return;
        collecting = true;
        web.evaluateJavascript("JSON.stringify(window.__pol?window.__pol.orders:[])", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                JSONArray orders = null;
                try {
                    Object v = new JSONTokener(value).nextValue();
                    if (v instanceof String) orders = clean(new JSONArray((String) v));
                } catch (Exception ignored) {
                }
                finishWith(orders, how, err);
            }
        });
    }

    private static String cut(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** Only the shape the app needs, from untrusted page text. */
    private static JSONArray clean(JSONArray in) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < in.length() && out.length() < 400; i++) {
            JSONObject r = in.optJSONObject(i);
            if (r == null) continue;
            String no = r.optString("no");
            String tab = r.optString("tab");
            if (!ORDER_NO.matcher(no).matches() || !("Ispunjen".equals(tab) || "Stigao".equals(tab) || "Zakasnio".equals(tab) || "Aktivan".equals(tab))) continue;
            try {
                JSONObject c = new JSONObject();
                c.put("no", no);
                c.put("name", cut(r.optString("name"), 60));
                c.put("status", cut(r.optString("status"), 40));
                c.put("date", cut(r.optString("date"), 12));
                c.put("n", Math.max(0, Math.min(999, r.optInt("n"))));
                c.put("tab", tab);
                if (r.has("ph")) c.put("ph", r.optString("ph").replaceAll("[^0-9+ /()-]", "").trim());
                JSONArray its = r.optJSONArray("items");
                if (its != null) {
                    JSONArray oi = new JSONArray();
                    for (int j = 0; j < its.length() && oi.length() < 60; j++) {
                        JSONObject it = its.optJSONObject(j);
                        if (it == null || !it.optString("num").matches("\\d{7}")) continue;
                        JSONObject x = new JSONObject();
                        x.put("num", it.optString("num"));
                        x.put("qty", Math.max(0, Math.min(99999, it.optInt("qty"))));
                        x.put("name", cut(it.optString("name"), 80));
                        x.put("st", cut(it.optString("st"), 30));
                        oi.put(x);
                    }
                    c.put("items", oi);
                }
                out.put(c);
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private void finishWith(JSONArray orders, String how, String err) {
        if (finished) return;
        finished = true;
        if (handler != null) handler.removeCallbacks(poll);
        Intent d = new Intent();
        try {
            JSONObject o = new JSONObject();
            o.put("how", how);
            o.put("err", err == null ? "" : cut(err, 80));
            o.put("at", System.currentTimeMillis());
            o.put("orders", orders == null ? new JSONArray() : orders);
            d.putExtra(EXTRA_JSON, o.toString());
        } catch (Exception ignored) {
        }
        setResult(RESULT_OK, d);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishWith(null, "cancelled", null);
    }

    @Override
    protected void onDestroy() {
        if (handler != null) handler.removeCallbacks(poll);
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        CookieManager.getInstance().flush();
        super.onDestroy();
    }
}
