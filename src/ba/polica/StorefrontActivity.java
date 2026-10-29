package ba.polica;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
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

import java.net.URLEncoder;
import java.util.regex.Pattern;

/**
 * The store system's web front inside the app. It opens its own article search for a code and reads the
 * visible text of the result list. The employee signs in on StoreFront's own page, once; the app never
 * sees or stores the password, and the page gets no access to the app (no JavaScript bridge here).
 * mode "lookup": returns the first articles found and closes. mode "view": stays open for browsing.
 */
public class StorefrontActivity extends Activity {
    private String host; // from the build (R.string.storefront_host), not part of the source
    static final String EXTRA_QUERY = "query";
    static final String EXTRA_MODE = "mode";
    static final String EXTRA_JSON = "json";
    private static final Pattern SAFE_QUERY = Pattern.compile("[0-9A-Za-z ]{1,40}");
    private static final long POLL_MS = 600;
    private static final long TIMEOUT_MS = 25000;

    // Reads the article cards from the visible text: "<name>", "<7 digits> (<status>)", then labelled values.
    private static final String EXTRACT =
        "(function(){try{var t=document.body.innerText.split('\\n').map(function(s){return s.trim()}).filter(Boolean);"
        + "var rx=/^(\\d{7}) \\((\\d+)\\)$/;var out=[];"
        + "for(var i=0;i<t.length;i++){var m=rx.exec(t[i]);if(!m)continue;"
        + "var r={num:m[1],status:m[2],name:i>0?t[i-1]:''};"
        + "for(var j=i+1;j<t.length&&j<i+40&&!rx.test(t[j]);j++){"
        + "if(t[j]==='Slobodna zaliha')r.free=t[j+1];"
        + "if(t[j]==='Zaliha u prodavaonici')r.stock=t[j+1];"
        + "if(t[j]==='Trenutna cijena')r.price=t[j+1];}"
        + "out.push(r);if(out.length>=6)break;}"
        + "var all=document.body.innerText;"
        + "return JSON.stringify({path:location.pathname,found:/Prona.eno\\s+\\d+/.test(all),"
        + "zero:/Prona.eno\\s+0\\b/.test(all)||/nema\\s+(rezultata|artikala)/i.test(all),out:out});"
        + "}catch(e){return JSON.stringify({path:location.pathname,error:true,out:[]})}})()";

    private WebView web;
    private TextView status;
    private Handler handler;
    private String query;
    private String mode;
    private String target;
    private long started;
    private boolean finished;
    private boolean reloaded;
    private int emptyHits;
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

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        host = new StringBuilder(getString(R.string.storefront_host)).reverse().toString();
        query = getIntent().getStringExtra(EXTRA_QUERY);
        mode = getIntent().getStringExtra(EXTRA_MODE);
        if (query == null || !SAFE_QUERY.matcher(query).matches()) {
            finishWith(null, "bad");
            return;
        }
        if (!"view".equals(mode)) mode = "lookup";
        try {
            target = "https://" + host + "/ui/article-search?query=" + URLEncoder.encode("\"" + query.trim() + "\"", "UTF-8");
        } catch (Exception e) {
            finishWith(null, "bad");
            return;
        }
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
        TextView close = barButton("Zatvori", blue);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finishWith(null, "cancelled");
            }
        });
        TextView title = new TextView(this);
        title.setText("StoreFront");
        title.setTextColor(ink);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        TextView chrome = barButton("Chrome", blue);
        chrome.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)));
                } catch (ActivityNotFoundException ignored) {
                }
                finishWith(null, "cancelled");
            }
        });
        bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) dp(44)));
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(chrome, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) dp(44)));
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
            public void onPageFinished(WebView v, String url) {
                AutoLogin.onPage(v.getContext(), v, url); // the session ran out: sign in again with the kept login
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                // sign-in pages of the company's identity provider are https too; everything else stays out
                return !"https".equals(r.getUrl().getScheme());
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) {
                updateStatus(url);
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
        status.setText("Tražim u StoreFrontu…");
        status.setVisibility(View.GONE);
        body.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        handler = new Handler(Looper.getMainLooper());
        started = System.currentTimeMillis();
        web.loadUrl(target);
        handler.postDelayed(poll, POLL_MS);
    }

    private TextView barButton(String text, int color) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setPadding((int) dp(14), 0, (int) dp(14), 0);
        return t;
    }

    private boolean onSearch(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return host.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/ui/article-search");
    }

    /** In lookup mode the page is covered by a short message while StoreFront's search runs. */
    private void updateStatus(String url) {
        if (status == null) return;
        status.setVisibility("lookup".equals(mode) && onSearch(url) ? View.VISIBLE : View.GONE);
    }

    private void check() {
        if (finished || web == null) return;
        final String url = web.getUrl();
        updateStatus(url);
        Uri u = url == null ? null : Uri.parse(url);
        if (u != null && host.equals(u.getHost()) && !onSearch(url) && !reloaded && u.getPath() != null && u.getPath().startsWith("/ui")) {
            // signed in and landed on StoreFront's start page: go to the search
            reloaded = true;
            web.loadUrl(target);
            return;
        }
        if (!onSearch(url)) {
            started = System.currentTimeMillis(); // signing in takes as long as it takes
            return;
        }
        if (System.currentTimeMillis() - started > TIMEOUT_MS) {
            finishWith(new JSONArray(), "timeout");
            return;
        }
        web.evaluateJavascript(EXTRACT, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (finished || value == null) return;
                try {
                    Object v = new JSONTokener(value).nextValue();
                    if (!(v instanceof String)) return;
                    JSONObject o = new JSONObject((String) v);
                    JSONArray out = o.optJSONArray("out");
                    if (out != null && out.length() > 0) {
                        if ("lookup".equals(mode)) finishWith(clean(out), "ok");
                    } else if (o.optBoolean("zero") && ++emptyHits >= 2) {
                        if ("lookup".equals(mode)) finishWith(new JSONArray(), "ok");
                    }
                } catch (Exception ignored) {
                }
            }
        });
    }

    private static String cut(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** Only what the app needs, from untrusted page text: shape and length are checked. */
    private static JSONArray clean(JSONArray in) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < in.length() && out.length() < 5; i++) {
            JSONObject r = in.optJSONObject(i);
            if (r == null) continue;
            String num = r.optString("num");
            if (!num.matches("\\d{7}")) continue;
            try {
                JSONObject c = new JSONObject();
                c.put("num", num);
                c.put("status", cut(r.optString("status"), 3));
                c.put("name", cut(r.optString("name"), 120));
                c.put("stock", cut(r.optString("stock"), 20));
                c.put("price", cut(r.optString("price"), 20));
                out.put(c);
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private void finishWith(JSONArray results, String how) {
        if (finished) return;
        finished = true;
        if (handler != null) handler.removeCallbacks(poll);
        Intent d = new Intent();
        try {
            JSONObject o = new JSONObject();
            o.put("query", query == null ? "" : query);
            o.put("how", how);
            o.put("results", results == null ? new JSONArray() : results);
            d.putExtra(EXTRA_JSON, o.toString());
        } catch (Exception ignored) {
        }
        setResult(RESULT_OK, d);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishWith(null, "cancelled");
    }

    @Override
    protected void onDestroy() {
        if (handler != null) handler.removeCallbacks(poll);
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        CookieManager.getInstance().flush(); // keeps the sign-in
        super.onDestroy();
    }
}
