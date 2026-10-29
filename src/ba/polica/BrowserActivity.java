package ba.polica;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * The app's own browser for MYJYSK: one news article, task or knowledge page, in the app's look, never handed to
 * Chrome. A news article opens in the reader (assets/reader: the article and its attachments through MYJYSK's own
 * calls, drawn over the page); "Originalna stranica" shows the page itself. An Excel attachment is read in the page and
 * handed to the app as a list (window.onAttachment); other attachments are saved to Downloads and opened. The page
 * gets no bridge to the app; the app only reads window.__jr. The sign-in is the employee's own (and AutoLogin).
 */
public class BrowserActivity extends Activity {
    static final String EXTRA_PATH = "path";
    static final String EXTRA_JSON = "json";
    static final String ATTACHMENT_FILE = "attachment.json";
    private static final Pattern SAFE_PATH = Pattern.compile("/ui/(tasks/[a-z]+|news/articles|knowledge-bases/\\d{1,6}/topics/\\d{1,8}/articles)/\\d{1,14}");
    private static final Pattern ARTICLE = Pattern.compile("^/ui/news/articles/\\d{1,14}.*");
    private static final int[] ZOOM = {100, 115, 130, 150};

    private String host;
    private String script;
    private WebView web;
    private TextView title, sub, segReader, segPage, back, fwd, zoom;
    private LinearLayout seg;
    private ProgressBar progress;
    private Handler handler;
    private boolean dark, reader = true, finished, taking;
    private int zoomAt;
    private int ink, ink2, blue, card, softBg;
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            look();
            if (!finished) handler.postDelayed(this, 500);
        }
    };

    private float dp(float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        host = MyjyskReader.hostOf(this);
        String path = getIntent().getStringExtra(EXTRA_PATH);
        if (!host.contains(".") || path == null || !SAFE_PATH.matcher(path).matches()) {
            finish();
            return;
        }
        try {
            script = asset("reader/xlsx-lite.js") + "\n" + asset("reader/reader.js");
        } catch (Exception e) {
            script = "";
        }
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = dark ? 0xFF0E1014 : 0xFFF3F4F7;
        ink = dark ? 0xFFEEF1F7 : 0xFF131620;
        ink2 = dark ? 0xFFA8AFBE : 0xFF596072;
        blue = dark ? 0xFF6D8BFF : 0xFF2B50E6;
        card = dark ? 0xFF171A21 : 0xFFFFFFFF;
        softBg = dark ? 0xFF1F232C : 0xFFE6E8EF;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (!dark) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | 0x00000010);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(bg);
        root.setFitsSystemWindows(true);

        // top: round back button, the page's title and where it is, round refresh button
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding((int) dp(8), (int) dp(10), (int) dp(8), (int) dp(8));
        TextView close = round("‹", 30, "Zatvori");
        close.setPadding(0, 0, 0, (int) dp(4));
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        mid.setGravity(Gravity.CENTER);
        mid.setPadding((int) dp(8), 0, (int) dp(8), 0);
        title = text("", 15, ink, true);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setGravity(Gravity.CENTER);
        sub = text("MYJYSK", 12, ink2, false);
        sub.setGravity(Gravity.CENTER);
        mid.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        mid.addView(sub, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView refresh = round("↻", 21, "Osvježi");
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (web != null) web.reload();
            }
        });
        bar.addView(close, new LinearLayout.LayoutParams((int) dp(44), (int) dp(44)));
        bar.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(refresh, new LinearLayout.LayoutParams((int) dp(44), (int) dp(44)));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(ColorStateList.valueOf(blue));
        progress.setProgressBackgroundTintList(ColorStateList.valueOf(softBg));
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) dp(3));
        pp.setMargins((int) dp(16), 0, (int) dp(16), (int) dp(6));
        root.addView(progress, pp);

        FrameLayout body = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(bg);
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
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                progress.setProgress(p);
                progress.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            }

            @Override
            public void onReceivedTitle(WebView v, String t) {
                updateBar();
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                // pages stay in this browser; only https (the sign-in page of the company is https too)
                return !"https".equals(r.getUrl().getScheme());
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap icon) {
                updateBar();
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                AutoLogin.onPage(v.getContext(), v, url);
                updateBar();
                if (reader) inject();
            }

            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean reload) {
                // MYJYSK moves between its pages without loading a new one
                updateBar();
                if (reader) handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        inject();
                    }
                }, 300);
            }
        });
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String cd, String mime, long len) {
                save(url, cd, mime);
            }
        });
        body.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // bottom: back, forward, text size; and the switch between the reader and the page itself
        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.setGravity(Gravity.CENTER_VERTICAL);
        nav.setPadding((int) dp(14), (int) dp(6), (int) dp(14), 0);
        back = flat("←", "Nazad");
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (web.canGoBack()) web.goBack();
            }
        });
        fwd = flat("→", "Naprijed");
        fwd.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (web.canGoForward()) web.goForward();
            }
        });
        zoom = flat("Aa", "Veličina teksta");
        zoom.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        zoom.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                zoomAt = (zoomAt + 1) % ZOOM.length;
                web.getSettings().setTextZoom(ZOOM[zoomAt]);
                Toast.makeText(BrowserActivity.this, "Tekst " + ZOOM[zoomAt] + " %", Toast.LENGTH_SHORT).show();
            }
        });
        nav.addView(back, new LinearLayout.LayoutParams(0, (int) dp(44), 1f));
        nav.addView(fwd, new LinearLayout.LayoutParams(0, (int) dp(44), 1f));
        nav.addView(zoom, new LinearLayout.LayoutParams(0, (int) dp(44), 1f));
        root.addView(nav, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        seg = new LinearLayout(this);
        seg.setOrientation(LinearLayout.HORIZONTAL);
        seg.setPadding((int) dp(4), (int) dp(4), (int) dp(4), (int) dp(4));
        GradientDrawable sb = new GradientDrawable();
        sb.setColor(softBg);
        sb.setCornerRadius(dp(24));
        seg.setBackground(sb);
        segReader = text("Čitač", 14, ink, true);
        segPage = text("Originalna stranica", 14, ink2, true);
        for (TextView t : new TextView[] {segReader, segPage}) {
            t.setGravity(Gravity.CENTER);
            seg.addView(t, new LinearLayout.LayoutParams(0, (int) dp(40), 1f));
        }
        segReader.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setReader(true);
            }
        });
        segPage.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setReader(false);
            }
        });
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sp.setMargins((int) dp(16), (int) dp(6), (int) dp(16), (int) dp(14));
        root.addView(seg, sp);
        setContentView(root);

        handler = new Handler(Looper.getMainLooper());
        paintSeg();
        updateBar();
        web.loadUrl("https://" + host + path);
        handler.postDelayed(poll, 500);
    }

    private TextView text(String t, float sp, int color, boolean bold) {
        TextView v = new TextView(this);
        v.setText(t);
        v.setTextColor(color);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    private TextView round(String t, float sp, String label) {
        TextView v = text(t, sp, ink, false);
        v.setGravity(Gravity.CENTER);
        v.setContentDescription(label);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(card);
        v.setBackground(d);
        v.setElevation(dp(3));
        return v;
    }

    private TextView flat(String t, String label) {
        TextView v = text(t, 22, ink, false);
        v.setGravity(Gravity.CENTER);
        v.setContentDescription(label);
        return v;
    }

    private boolean onHost(String url) {
        try {
            Uri u = Uri.parse(url);
            return "https".equals(u.getScheme()) && host.equals(u.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isArticle(String url) {
        if (url == null || !onHost(url)) return false;
        String p = Uri.parse(url).getPath();
        return p != null && ARTICLE.matcher(p).matches();
    }

    private void updateBar() {
        if (web == null) return;
        String url = web.getUrl();
        String t = web.getTitle();
        if (t != null) t = t.replaceAll("\\s+-\\s+(Vijesti\\s+-\\s+)?MYJYSK\\s*$", "").trim();
        if (AutoLogin.isLoginPage(this, url)) t = "Prijava";
        title.setText(t == null || t.isEmpty() || (url != null && t.startsWith("http")) ? "Učitavam…" : t);
        String h = "";
        try {
            h = url == null ? "" : Uri.parse(url).getHost();
        } catch (Exception ignored) {
        }
        sub.setText(onHost(String.valueOf(url)) ? (isArticle(url) ? "MYJYSK · Vijesti" : "MYJYSK") : h == null ? "" : h);
        boolean art = isArticle(url);
        seg.setVisibility(art ? View.VISIBLE : View.GONE);
        back.setAlpha(web.canGoBack() ? 1f : 0.35f);
        fwd.setAlpha(web.canGoForward() ? 1f : 0.35f);
    }

    private void paintSeg() {
        GradientDrawable on = new GradientDrawable();
        on.setColor(card);
        on.setCornerRadius(dp(20));
        segReader.setBackground(reader ? on : null);
        segPage.setBackground(reader ? null : on);
        segReader.setTextColor(reader ? ink : ink2);
        segPage.setTextColor(reader ? ink2 : ink);
    }

    private void setReader(boolean on) {
        reader = on;
        paintSeg();
        if (on) inject();
        else web.evaluateJavascript("window.__jr&&window.__jr.hide()", null);
    }

    private void inject() {
        if (web == null || script.isEmpty() || !reader) return;
        if (!isArticle(web.getUrl())) {
            web.evaluateJavascript("window.__jr&&window.__jr.hide()", null); // moved on to a page that is not a news article
            return;
        }
        web.evaluateJavascript("window.__jrDark=" + dark + ";" + script, null);
    }

    /** Looks whether the reader read an Excel attachment; takes it once. */
    private void look() {
        if (finished || taking || web == null || !isArticle(web.getUrl())) return;
        web.evaluateJavascript("(function(j){return j&&j.open?'1':''})(window.__jr)", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("1") || taking) return;
                taking = true;
                web.evaluateJavascript("(function(){var o=window.__jr.open;window.__jr.open=null;return JSON.stringify(o)})()", new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        taking = false;
                        try {
                            Object a = new JSONTokener(v).nextValue();
                            if (!(a instanceof String)) return;
                            JSONObject o = new JSONObject((String) a);
                            if (o.optJSONArray("rows") == null) return;
                            JSONObject out = new JSONObject();
                            out.put("name", o.optString("name"));
                            out.put("title", o.optString("title"));
                            String id = o.optString("id");
                            out.put("path", id.matches("\\d{1,14}") ? "/ui/news/articles/" + id : "");
                            out.put("rows", o.getJSONArray("rows"));
                            out.put("at", System.currentTimeMillis());
                            File d = new File(getFilesDir(), "data");
                            if (!d.isDirectory()) d.mkdirs();
                            FileOutputStream f = new FileOutputStream(new File(d, ATTACHMENT_FILE));
                            f.write(out.toString().getBytes(StandardCharsets.UTF_8));
                            f.close();
                            finished = true;
                            Intent r = new Intent();
                            r.putExtra(EXTRA_JSON, "{\"how\":\"xlsx\"}");
                            setResult(RESULT_OK, r);
                            finish();
                        } catch (Exception e) {
                            Toast.makeText(BrowserActivity.this, "Prilog se ne može prikazati.", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            }
        });
    }

    /** Saves an attachment to Downloads (in the background) and opens it with the phone's app for that kind of file. */
    private void save(final String url, final String cd, final String mime) {
        final String name = URLUtil.guessFileName(url, cd, mime).replaceAll("[\\\\/:*?\"<>|]", "_");
        Toast.makeText(this, "Preuzimam " + name + "…", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                Uri saved = null;
                String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
                try {
                    if (!url.startsWith("https://")) throw new Exception("not https");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(30000);
                    if (onHost(url)) {
                        String ck = CookieManager.getInstance().getCookie(url); // the sign-in goes to MYJYSK only
                        if (ck != null) c.setRequestProperty("Cookie", ck);
                    }
                    if (c.getResponseCode() / 100 != 2) throw new Exception("http " + c.getResponseCode());
                    InputStream in = c.getInputStream();
                    try {
                        if (Build.VERSION.SDK_INT >= 29) {
                            ContentValues cv = new ContentValues();
                            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                            cv.put(MediaStore.MediaColumns.MIME_TYPE, type);
                            cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                            Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                            if (u == null) throw new Exception("no place");
                            OutputStream out = getContentResolver().openOutputStream(u);
                            copy(in, out);
                            out.close();
                            cv.clear();
                            cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                            getContentResolver().update(u, cv, null, null);
                            saved = u;
                        } else {
                            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                            if (dir != null && !dir.isDirectory()) dir.mkdirs();
                            OutputStream out = new FileOutputStream(new File(dir, name));
                            copy(in, out);
                            out.close();
                        }
                    } finally {
                        in.close();
                    }
                } catch (Exception e) {
                    toast("Prilog se nije mogao preuzeti.");
                    return;
                }
                final Uri open = saved;
                final String t = type;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (open == null) {
                            Toast.makeText(BrowserActivity.this, name + " je sačuvan u aplikaciji (Preuzimanja).", Toast.LENGTH_LONG).show();
                            return;
                        }
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(open, t).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                        } catch (ActivityNotFoundException e) {
                            Toast.makeText(BrowserActivity.this, name + " je sačuvan u Preuzimanja.", Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
        }).start();
    }

    private void toast(final String t) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(BrowserActivity.this, t, Toast.LENGTH_LONG).show();
            }
        });
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private String asset(String name) throws java.io.IOException {
        InputStream in = getAssets().open(name);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        copy(in, bo);
        in.close();
        return bo.toString("UTF-8");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        finished = true;
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
