package ba.polica;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Hosts the interface (assets/index.html) in a WebView. The page is served from
 * https://appassets.androidplatform.net/ by this class, so it never touches the network:
 * any other address is answered with an empty 403.
 */
public class MainActivity extends Activity {
    private static final String TAG = "Polica";
    static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/assets/index.html";
    private static final int REQ_PICK = 1;
    private static final int REQ_SCAN = 2;
    private static final int REQ_STORE = 3;
    private static final int REQ_ORDERS = 4;
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9._-]{1,80}");
    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("webp", "image/webp");
        MIME.put("jpg", "image/jpeg");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("wasm", "application/wasm");
        MIME.put("pdf", "application/pdf");
        MIME.put("txt", "text/plain");
    }

    private WebView web;
    private boolean pageReady;
    private Intent pendingImport;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Updater updater;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        applyBars();
        web = new WebView(this);
        web.setBackgroundColor(barsDark() ? 0xFF0E1014 : 0xFFF3F4F7);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        updater = new Updater(this);
        web.addJavascriptInterface(new Bridge(), "Android");
        setContentView(web);
        web.loadUrl(START);
        takeImport(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeImport(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pageReady) runJs("window.appResume&&appResume()");
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        applyBars();
        if (pageReady) runJs("window.themeChanged&&themeChanged(" + isDark() + ")");
    }

    @Override
    public void onBackPressed() {
        if (!pageReady || web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.handleBack?handleBack():false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled) && !isFinishing()) MainActivity.super.onBackPressed();
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("Android");
            web.destroy();
            web = null;
        }
        io.shutdown();
        super.onDestroy();
    }

    boolean isDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    private int themePref = 0; // 0 = like the phone, 1 = light, 2 = dark

    private boolean barsDark() {
        return themePref == 2 || (themePref == 0 && isDark());
    }

    private void applyBars() {
        boolean dark = barsDark();
        int bg = dark ? 0xFF0E1014 : 0xFFF3F4F7;
        Window w = getWindow();
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        int flags = 0;
        if (!dark) flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | 0x00000010; // + light navigation bar
        w.getDecorView().setSystemUiVisibility(flags);
    }

    private final List<String> pendingJs = new ArrayList<>();

    /** Runs code in the page; calls made before the page has loaded wait for it. */
    void runJs(final String code) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (web == null || isDestroyed()) return;
                if (!pageReady) {
                    pendingJs.add(code);
                    return;
                }
                web.evaluateJavascript(code, null);
            }
        });
    }

    // ------------------------------------------------------------------ files

    File dir(String name) {
        File d = new File(getFilesDir(), name);
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    static boolean safe(String name) {
        return name != null && SAFE_NAME.matcher(name).matches() && !name.startsWith(".");
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    /** Writes through a temporary file, so a crash never leaves half a file behind. */
    static boolean writeAtomic(File f, byte[] data) {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try {
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(data);
                out.getFD().sync();
            } finally {
                out.close();
            }
            return tmp.renameTo(f);
        } catch (IOException e) {
            Log.w(TAG, "write " + f, e);
            tmp.delete();
            return false;
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        try {
            Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) name = c.getString(0);
                } finally {
                    c.close();
                }
            }
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "planogram.pdf" : name;
    }

    /** Copies picked or shared PDFs into the app and hands the list to the page. */
    private void importUris(final List<Uri> uris) {
        if (uris.isEmpty()) {
            runJs("window.onPicked&&onPicked([])");
            return;
        }
        runJs("window.onPicking&&onPicking(" + uris.size() + ")");
        io.execute(new Runnable() {
            @Override
            public void run() {
                JSONArray out = new JSONArray();
                File inbox = dir("inbox");
                ContentResolver cr = getContentResolver();
                for (Uri uri : uris) {
                    JSONObject o = new JSONObject();
                    String name = displayName(uri);
                    try {
                        o.put("name", name);
                        String file = UUID.randomUUID().toString().replace("-", "") + ".pdf";
                        File dst = new File(inbox, file);
                        InputStream in = cr.openInputStream(uri);
                        if (in == null) throw new IOException("no stream");
                        try {
                            FileOutputStream fo = new FileOutputStream(dst);
                            try {
                                copy(in, fo);
                            } finally {
                                fo.close();
                            }
                        } finally {
                            in.close();
                        }
                        o.put("file", file);
                        o.put("size", dst.length());
                    } catch (Exception e) {
                        Log.w(TAG, "import " + uri, e);
                        try {
                            o.put("error", String.valueOf(e.getMessage()));
                        } catch (Exception ignored) {
                        }
                    }
                    out.put(o);
                }
                runJs("window.onPicked&&onPicked(" + out + ")");
            }
        });
    }

    private void takeImport(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else {
            return;
        }
        // handle each share once, even if the activity is recreated
        intent.setAction(Intent.ACTION_MAIN);
        if (uris.isEmpty()) return;
        if (pageReady) {
            importUris(uris);
        } else {
            Intent keep = new Intent();
            keep.putParcelableArrayListExtra("uris", new ArrayList<>(uris));
            pendingImport = keep;
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_PICK) {
            List<Uri> uris = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri u = clip.getItemAt(i).getUri();
                        if (u != null) uris.add(u);
                    }
                } else if (data.getData() != null) {
                    uris.add(data.getData());
                }
            }
            importUris(uris);
        } else if (req == REQ_STORE) {
            String json = data == null ? null : data.getStringExtra(StorefrontActivity.EXTRA_JSON);
            runJs("window.onStorefront&&onStorefront(" + (json == null ? "{how:'cancelled',results:[]}" : json) + ")");
        } else if (req == REQ_ORDERS) {
            String json = data == null ? null : data.getStringExtra(OrdersActivity.EXTRA_JSON);
            runJs("window.onOrders&&onOrders(" + (json == null ? "{how:'cancelled',orders:[]}" : json) + ")");
        } else if (req == REQ_SCAN) {
            String js;
            if (result == RESULT_OK && data != null && data.getStringExtra("code") != null) {
                JSONObject o = new JSONObject();
                try {
                    o.put("code", data.getStringExtra("code"));
                    o.put("format", data.getStringExtra("format"));
                } catch (Exception ignored) {
                }
                js = "window.onScan&&onScan(" + o + ")";
            } else if (result == ScanActivity.RESULT_MANUAL) {
                js = "window.onScan&&onScan({manual:true})";
            } else {
                js = "window.onScan&&onScan(null)";
            }
            runJs(js);
        }
    }

    // ------------------------------------------------------------- web server

    private class LocalClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if ("tel".equals(u.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_DIAL, u)); // the dialer opens with the number, nothing is called
                } catch (ActivityNotFoundException ignored) {
                }
            }
            return true; // the interface never navigates away
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            for (String js : pendingJs) view.evaluateJavascript(js, null);
            pendingJs.clear();
            if (pendingImport != null) {
                ArrayList<Uri> uris = pendingImport.getParcelableArrayListExtra("uris");
                pendingImport = null;
                if (uris != null) importUris(uris);
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return status(403);
            String path = u.getPath();
            if (path == null) return status(404);
            try {
                if (path.startsWith("/assets/")) {
                    String rel = path.substring("/assets/".length());
                    if (rel.contains("..")) return status(404);
                    return ok(mime(rel), getAssets().open(rel), false);
                }
                if (path.startsWith("/files/")) {
                    String[] parts = path.substring("/files/".length()).split("/");
                    File f;
                    if (parts.length == 2 && ("plans".equals(parts[0]) || "inbox".equals(parts[0])) && safe(parts[1])) {
                        f = new File(dir(parts[0]), parts[1]);
                    } else if (parts.length == 3 && "thumbs".equals(parts[0]) && safe(parts[1]) && safe(parts[2])) {
                        f = new File(new File(dir("thumbs"), parts[1]), parts[2]);
                    } else {
                        return status(404);
                    }
                    if (!f.isFile()) return status(404);
                    // pictures never change under the same name; documents may
                    return ok(mime(f.getName()), new FileInputStream(f), "thumbs".equals(parts[0]));
                }
            } catch (IOException e) {
                return status(404);
            }
            return status(404);
        }
    }

    private static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    private static WebResourceResponse ok(String mime, InputStream in, boolean cache) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", cache ? "max-age=31536000" : "no-store");
        h.put("X-Content-Type-Options", "nosniff");
        String enc = mime.startsWith("text/") || mime.endsWith("json") ? "utf-8" : null;
        return new WebResourceResponse(mime, enc, 200, "OK", h, in);
    }

    private static WebResourceResponse status(int code) {
        Map<String, String> h = new HashMap<>();
        return new WebResourceResponse("text/plain", "utf-8", code, code == 403 ? "Forbidden" : "Not Found", h,
                new ByteArrayInputStream(new byte[0]));
    }

    private boolean probing;

    private void probeStore() {
        if (probing) return;
        probing = true;
        StoreProbe.run(this, (android.view.ViewGroup) getWindow().getDecorView(), new StoreProbe.Callback() {
            @Override
            public void done(boolean online, String counts) {
                probing = false;
                runJs("window.onStoreStatus&&onStoreStatus(" + online + "," + org.json.JSONObject.quote(counts) + ")");
            }
        });
    }

    private static final int REQ_NOTIF = 9;

    // ----------------------------------------------------------------- bridge

    /** Methods the page calls as window.Android.*. They run on a WebView binder thread. */
    public class Bridge {
        /** Asks StoreFront, in a hidden page with the app's own sign-in, whether it still lets the employee in. Answer: window.onStoreStatus(bool). */
        @JavascriptInterface
        public void storeStatus() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    probeStore();
                }
            });
        }

        /** Background look at the order numbers: on/off, and the numbers of the last full read. */
        @JavascriptInterface
        public void watch(final boolean on, final String base) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if (on && Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
                    }
                    OrderWatch.set(MainActivity.this, on, base);
                }
            });
        }

        @JavascriptInterface
        public void setTheme(final String t) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    themePref = "dark".equals(t) ? 2 : "light".equals(t) ? 1 : 0;
                    applyBars();
                    web.setBackgroundColor(barsDark() ? 0xFF0E1014 : 0xFFF3F4F7);
                }
            });
        }

        @JavascriptInterface
        public boolean isDark() {
            return MainActivity.this.isDark();
        }

        @JavascriptInterface
        public String version() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /** A small JSON file the page keeps (planogram index, settings, history). */
        @JavascriptInterface
        public String readText(String name) {
            if (!safe(name)) return null;
            File f = new File(dir("data"), name);
            if (!f.isFile()) return null;
            try {
                FileInputStream in = new FileInputStream(f);
                try {
                    byte[] b = new byte[(int) f.length()];
                    int off = 0;
                    while (off < b.length) {
                        int n = in.read(b, off, b.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                    return new String(b, 0, off, StandardCharsets.UTF_8);
                } finally {
                    in.close();
                }
            } catch (IOException e) {
                return null;
            }
        }

        @JavascriptInterface
        public boolean writeText(String name, String text) {
            if (!safe(name) || text == null) return false;
            return writeAtomic(new File(dir("data"), name), text.getBytes(StandardCharsets.UTF_8));
        }

        @JavascriptInterface
        public boolean deleteText(String name) {
            if (!safe(name)) return false;
            File f = new File(dir("data"), name);
            return !f.exists() || f.delete();
        }

        /** Moves an imported PDF from the inbox to the kept planograms. */
        @JavascriptInterface
        public boolean keepPdf(String inboxFile, String planFile) {
            if (!safe(inboxFile) || !safe(planFile)) return false;
            File src = new File(dir("inbox"), inboxFile);
            File dst = new File(dir("plans"), planFile);
            if (!src.isFile()) return false;
            if (dst.exists()) dst.delete();
            return src.renameTo(dst);
        }

        @JavascriptInterface
        public boolean removePdf(String planFile) {
            if (!safe(planFile)) return false;
            File f = new File(dir("plans"), planFile);
            return !f.exists() || f.delete();
        }

        /** Saves one article picture (base64) for a planogram. */
        @JavascriptInterface
        public boolean writeThumb(String planId, String name, String base64) {
            if (!safe(planId) || !safe(name) || base64 == null) return false;
            File d = new File(dir("thumbs"), planId);
            if (!d.isDirectory() && !d.mkdirs()) return false;
            try {
                byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                return writeAtomic(new File(d, name), data);
            } catch (IllegalArgumentException e) {
                return false;
            }
        }

        @JavascriptInterface
        public void removeThumbs(String planId) {
            if (!safe(planId)) return;
            File d = new File(dir("thumbs"), planId);
            File[] fs = d.listFiles();
            if (fs != null) for (File f : fs) f.delete();
            d.delete();
        }

        @JavascriptInterface
        public void clearInbox() {
            File[] fs = dir("inbox").listFiles();
            if (fs != null) for (File f : fs) f.delete();
        }

        @JavascriptInterface
        public void pickPdfs() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/pdf");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    try {
                        startActivityForResult(i, REQ_PICK);
                    } catch (ActivityNotFoundException e) {
                        Intent g = new Intent(Intent.ACTION_GET_CONTENT);
                        g.addCategory(Intent.CATEGORY_OPENABLE);
                        g.setType("application/pdf");
                        g.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                        try {
                            startActivityForResult(g, REQ_PICK);
                        } catch (ActivityNotFoundException e2) {
                            runJs("window.onPicked&&onPicked(null)");
                        }
                    }
                }
            });
        }

        /** Opens StoreFront for a code (digits and letters only); the answer comes to window.onStorefront. */
        @JavascriptInterface
        public void storefront(final String query, final String mode) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(MainActivity.this, StorefrontActivity.class);
                    i.putExtra(StorefrontActivity.EXTRA_QUERY, query);
                    i.putExtra(StorefrontActivity.EXTRA_MODE, mode);
                    startActivityForResult(i, REQ_STORE);
                }
            });
        }

        /** Reads the customer orders from StoreFront; known = order numbers already read (JSON array). Answer: window.onOrders. */
        @JavascriptInterface
        public void orders(final String known, final String tabs) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(MainActivity.this, OrdersActivity.class);
                    i.putExtra(OrdersActivity.EXTRA_KNOWN, known);
                    i.putExtra(OrdersActivity.EXTRA_TABS, tabs);
                    startActivityForResult(i, REQ_ORDERS);
                }
            });
        }

        /** Looks for a newer version of the app (download = fetch it too). Answers arrive in window.onUpdate. */
        @JavascriptInterface
        public void checkUpdate(boolean download) {
            updater.check(download, new Updater.Listener() {
                @Override
                public void on(final org.json.JSONObject state) {
                    runJs("window.onUpdate&&onUpdate(" + state + ")");
                }
            });
        }

        /** Hands the downloaded update to Android's installer; returns ok | permission | none | error. */
        @JavascriptInterface
        public String installUpdate() {
            return updater.install();
        }

        @JavascriptInterface
        public void scan() {
            scanWith(true);
        }

        /** Opens the scanner; vibrate = short buzz when a code is read (a setting of the app). */
        @JavascriptInterface
        public void scanWith(final boolean vibrate) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(MainActivity.this, ScanActivity.class);
                    i.putExtra("vibrate", vibrate);
                    startActivityForResult(i, REQ_SCAN);
                    overridePendingTransition(0, 0);
                }
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            v.vibrate(VibrationEffect.createOneShot(Math.max(10, Math.min(ms, 200)), VibrationEffect.DEFAULT_AMPLITUDE));
        }

        @JavascriptInterface
        public void openAppSettings() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        Log.w(TAG, "settings", e);
                    }
                }
            });
        }

        /** Signs out of StoreFront: removes the cookies of the in-app StoreFront pages. */
        @JavascriptInterface
        public void clearStorefront() {
            CookieManager cm = CookieManager.getInstance();
            cm.removeAllCookies(null);
            cm.flush();
        }

        @JavascriptInterface
        public String device() {
            return Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE;
        }
    }
}
