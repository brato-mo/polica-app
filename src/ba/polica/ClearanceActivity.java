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
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
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

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Reads the list of articles that are in stock and have a given status code (21, 81) in one product group from the
 * store system's own article search, so the app can show what has to be sold. The employee is signed in on that
 * page; this only reads what the page shows: one page load per status, the rows of the table are handed to the app
 * as text. Nothing is sent anywhere.
 */
public class ClearanceActivity extends Activity {
    static final String EXTRA_STATUSES = "statuses";
    static final String EXTRA_GROUP = "group";
    static final String EXTRA_JSON = "json";
    private static final long POLL_MS = 400;
    private static final long STALL_MS = 60000;
    private static final int PAGE_SIZE = 200;
    private static final int MAX_PAGES = 4;
    private static final Pattern CODE = Pattern.compile("\\d{2}");
    private static final Pattern GROUP = Pattern.compile("\\d{1,3}");

    private String host;
    private WebView web;
    private TextView status;
    private Handler handler;
    private final List<String> statuses = new ArrayList<>();
    private String group = "5";
    private int si;
    private int page = 1;
    private int epoch;
    private int waitEpoch;
    private String last = "";
    private int same;
    private int rows;
    private final StringBuilder text = new StringBuilder();
    private final JSONArray parts = new JSONArray();
    private boolean finished;
    private boolean reloaded;
    private boolean reading;
    private long lastMove;
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

    private boolean onSearch(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return host.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/ui/article-search");
    }

    private String urlFor(String st, int pg) {
        return "https://" + host + "/ui/article-search?query=&articlesSorting=relevance&articlesInStock=true"
            + "&statusCode=%5B%22" + st + "%22%5D&storageStatus=%5B%5D&categories=%5B%22" + group + "%22%5D"
            + "&discontinuationDate=%5B%5D&articlesActiveFilter=false&articlesMarkedForDeletion=false"
            + "&articlesWithSMValues=false&articlesWithDMValueFilter=false&page=" + pg + "&pageSize=" + PAGE_SIZE;
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        host = new StringBuilder(getString(R.string.storefront_host)).reverse().toString();
        try {
            JSONArray k = new JSONArray(getIntent().getStringExtra(EXTRA_STATUSES));
            for (int i = 0; i < k.length() && statuses.size() < 6; i++) {
                String s = k.optString(i);
                if (CODE.matcher(s).matches() && !statuses.contains(s)) statuses.add(s);
            }
        } catch (Exception ignored) {
        }
        String g = getIntent().getStringExtra(EXTRA_GROUP);
        if (g != null && GROUP.matcher(g).matches()) group = g;
        if (statuses.isEmpty()) {
            finishWith("error", "statuses");
            return;
        }
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
                finishWith("cancelled", null);
            }
        });
        TextView title = new TextView(this);
        title.setText("Artikli za rasprodaju");
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
                epoch++;
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
        status.setText("Čitam artikle za rasprodaju…");
        status.setVisibility(View.GONE);
        body.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        handler = new Handler(Looper.getMainLooper());
        lastMove = System.currentTimeMillis();
        load();
        handler.postDelayed(poll, POLL_MS);
    }

    /** Asks for the page of the status and page number that is being read. */
    private void load() {
        waitEpoch = epoch + 1;
        last = "";
        same = 0;
        web.loadUrl(urlFor(statuses.get(si), page));
    }

    private void showStatus(String url) {
        if (status != null) status.setVisibility(onSearch(url) ? View.VISIBLE : View.GONE);
    }

    private void check() {
        if (finished || web == null || reading) return;
        final String url = web.getUrl();
        showStatus(url);
        Uri u = url == null ? null : Uri.parse(url);
        if (!onSearch(url)) {
            lastMove = System.currentTimeMillis(); // signing in takes as long as it takes
            if (u != null && host.equals(u.getHost()) && !reloaded && u.getPath() != null && u.getPath().startsWith("/ui")) {
                reloaded = true;
                load();
            }
            return;
        }
        if (epoch < waitEpoch) return; // the page that is still on screen is the old one
        final int myEpoch = epoch, mySi = si, myPage = page;
        status.setText("Čitam artikle za rasprodaju…\nStatus " + statuses.get(si) + " (" + (si + 1) + " od " + statuses.size() + ")"
            + (rows > 0 ? "\n" + rows + " artikala" : ""));
        web.evaluateJavascript("(function(){var m=document.querySelector('main');if(!m)return '';var t=m.innerText||'';"
            + "var f=/Prona\\S* (\\d+) artik/.exec(t);var many=/previ\\S+ rezultata/i.test(t);var ls=t.split('\\n'),r=0;"
            + "for(var i=0;i<ls.length;i++)if(/^\\d{7} \\(\\d{1,2}\\)\\t/.test(ls[i]))r++;"
            + "return JSON.stringify({f:f?+f[1]:-1,r:r,m:many})})()", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (finished || reading || value == null) return;
                    if (myEpoch != epoch || mySi != si || myPage != page) return; // answer of a page that is gone
                    try {
                        Object v = new JSONTokener(value).nextValue();
                        if (!(v instanceof String) || ((String) v).isEmpty()) {
                            if (System.currentTimeMillis() - lastMove > STALL_MS) timeout();
                            return;
                        }
                        JSONObject o = new JSONObject((String) v);
                        int f = o.optInt("f", -1);
                        int r = o.optInt("r");
                        String key = si + "/" + page + "/" + f + "/" + r + "/" + o.optBoolean("m");
                        if (!key.equals(last)) {
                            last = key;
                            same = 0;
                            lastMove = System.currentTimeMillis();
                            return;
                        }
                        same++;
                        if (o.optBoolean("m")) {
                            if (same >= 2) partDone(-1, true);
                            return;
                        }
                        int expect = f < 0 ? -1 : Math.min(PAGE_SIZE, f - (page - 1) * PAGE_SIZE);
                        if (expect >= 0 && ((r >= expect && same >= 2) || (r > 0 && same >= 10))) {
                            if (expect == 0) {
                                partDone(f, false);
                            } else {
                                grab(f);
                            }
                        } else if (System.currentTimeMillis() - lastMove > STALL_MS) {
                            timeout();
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
    }

    /** The rows of the table on this page, as text (tab-separated), to be read by the app. */
    private void grab(final int found) {
        reading = true;
        web.evaluateJavascript("(function(){var m=document.querySelector('main');var ls=(m?m.innerText:'').split('\\n'),o=[];"
            + "for(var i=0;i<ls.length&&o.length<400;i++)if(/^\\d{7} \\(\\d{1,2}\\)\\t/.test(ls[i]))o.push(ls[i].slice(0,500));"
            + "return o.join('\\n')})()", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    reading = false;
                    if (finished) return;
                    try {
                        Object v = new JSONTokener(value == null ? "\"\"" : value).nextValue();
                        String t = v instanceof String ? (String) v : "";
                        if (text.length() + t.length() < 300000) {
                            if (text.length() > 0 && t.length() > 0) text.append('\n');
                            text.append(t);
                            for (int i = 0; i < t.length(); i++) if (t.charAt(i) == '\n') rows++;
                            if (t.length() > 0) rows++;
                        }
                    } catch (Exception ignored) {
                    }
                    if (found > page * PAGE_SIZE && page < MAX_PAGES) {
                        page++;
                        load();
                    } else {
                        partDone(found, false);
                    }
                }
            });
    }

    private void partDone(int found, boolean limited) {
        try {
            JSONObject p = new JSONObject();
            p.put("st", statuses.get(si));
            p.put("found", found);
            p.put("limited", limited);
            p.put("text", limited ? "" : text.toString());
            parts.put(p);
        } catch (Exception ignored) {
        }
        text.setLength(0);
        rows = 0;
        page = 1;
        si++;
        lastMove = System.currentTimeMillis();
        if (si >= statuses.size()) {
            finishWith("ok", null);
        } else {
            load();
        }
    }

    private void timeout() {
        finishWith(parts.length() > 0 ? "partial" : "timeout", null);
    }

    private static String cut(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    private void finishWith(String how, String err) {
        if (finished) return;
        finished = true;
        if (handler != null) handler.removeCallbacks(poll);
        Intent d = new Intent();
        try {
            JSONObject o = new JSONObject();
            o.put("how", how);
            o.put("err", err == null ? "" : cut(err, 80));
            o.put("at", System.currentTimeMillis());
            o.put("group", group);
            o.put("parts", parts);
            d.putExtra(EXTRA_JSON, o.toString());
        } catch (Exception ignored) {
        }
        setResult(RESULT_OK, d);
        finish();
    }

    @Override
    public void onBackPressed() {
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
        CookieManager.getInstance().flush();
        super.onDestroy();
    }
}
