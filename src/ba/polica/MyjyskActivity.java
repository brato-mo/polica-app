package ba.polica;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * MYJYSK inside the app, on the whole screen. mode "login": the employee signs in on MYJYSK's own page (the app never
 * sees the password); once in, the tasks and news are read and the screen closes. mode "view": one task or news
 * article opened for reading; stays open. The page gets no access to the app (no JavaScript bridge here).
 */
public class MyjyskActivity extends Activity {
    static final String EXTRA_MODE = "mode";
    static final String EXTRA_PATH = "path";
    static final String EXTRA_JSON = "json";
    static final String EXTRA_URL = "url";
    private static final Pattern SAFE_PATH = Pattern.compile("/ui/(tasks/[a-z]+|news/articles|knowledge-bases/\\d{1,6}/topics/\\d{1,8}/articles)/\\d{1,14}");
    private static final long POLL_MS = 900;

    private MyjyskReader reader;
    private WebView web;
    private TextView note;
    private Handler handler;
    private String mode;
    private String target;
    private boolean finished;
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
        reader = new MyjyskReader(this);
        if (!MyjyskReader.enabled(this)) {
            finishWith("off", null);
            return;
        }
        String m = getIntent().getStringExtra(EXTRA_MODE);
        mode = "view".equals(m) || "plans".equals(m) ? m : "login";
        String path = getIntent().getStringExtra(EXTRA_PATH);
        if ("plans".equals(mode)) {
            // the planogram server's own sign-in: only its address, from the build
            String ph = new StringBuilder(getString(R.string.plans_host)).reverse().toString().trim();
            Uri pu = Uri.parse(String.valueOf(getIntent().getStringExtra(EXTRA_URL)));
            if (ph.isEmpty() || !ph.equalsIgnoreCase(pu.getHost())) {
                finishWith("bad", null);
                return;
            }
            target = "https://" + pu.getHost() + pu.getEncodedPath() + (pu.getEncodedQuery() == null ? "" : "?" + pu.getEncodedQuery());
        } else if ("view".equals(mode)) {
            if (path == null || !SAFE_PATH.matcher(path).matches()) {
                finishWith("bad", null);
                return;
            }
            target = "https://" + reader.host + path;
        } else {
            target = reader.home();
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
                finishWith("cancelled", null);
            }
        });
        TextView title = new TextView(this);
        title.setText("plans".equals(mode) ? "Planogrami" : "MYJYSK");
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
            }
        });
        bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) dp(44)));
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(chrome, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (int) dp(44)));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        note = new TextView(this);
        note.setTextColor(ink);
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        note.setGravity(Gravity.CENTER);
        note.setPadding((int) dp(16), (int) dp(6), (int) dp(16), (int) dp(10));
        note.setText("Prijavi se u MYJYSK. Kad uđeš, zadaci i vijesti se učitaju i ovaj ekran se sam zatvori.");
        if ("plans".equals(mode)) note.setText("Prijavi se isto kao u MYJYSK. Kad se prijaviš, ovaj ekran se sam zatvori i planogrami se preuzmu.");
        note.setVisibility("view".equals(mode) ? View.GONE : View.VISIBLE);
        root.addView(note, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

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
                // sign-in pages of the company's identity provider are https too; everything else stays out
                return !"https".equals(r.getUrl().getScheme());
            }
        });
        // planogram server: once signed in, it sends the PDF, which a WebView hands over as a download. That means
        // the sign-in worked; the app downloads the planograms itself with the new sign-in.
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String cd, String mime, long len) {
                if ("plans".equals(mode)) finishWith("ok", null);
            }
        });
        body.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        handler = new Handler(Looper.getMainLooper());
        web.loadUrl(target);
        if ("login".equals(mode)) handler.postDelayed(poll, 1500);
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

    private void check() {
        if (finished || web == null) return;
        reader.poll(web, new MyjyskReader.Result() {
            @Override
            public void on(String state, JSONObject data) {
                if (finished) return;
                if ("ok".equals(state)) {
                    finishWith("ok", data);
                } else if ("busy".equals(state)) {
                    note.setText("Učitavam zadatke i vijesti…");
                } else if ("login".equals(state)) {
                    // MYJYSK page is open but the data is not given yet: let the employee sign in, then read again
                    note.setText("Prijavi se u MYJYSK. Kad uđeš, zadaci i vijesti se učitaju i ovaj ekran se sam zatvori.");
                    reader.reset();
                }
            }
        });
    }

    private void finishWith(String how, JSONObject data) {
        if (finished) return;
        finished = true;
        if (handler != null) handler.removeCallbacks(poll);
        Intent d = new Intent();
        try {
            JSONObject o = new JSONObject();
            o.put("how", how);
            o.put("at", System.currentTimeMillis());
            if (data != null) o.put("data", data);
            d.putExtra(EXTRA_JSON, o.toString());
        } catch (Exception ignored) {
        }
        setResult(RESULT_OK, d);
        finish();
    }

    @Override
    public void onBackPressed() {
        if ("view".equals(mode) && web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        finishWith("cancelled", null);
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
