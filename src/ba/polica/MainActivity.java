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
    private static final int REQ_CLEAR = 5;
    private static final int REQ_MYJYSK = 6;
    private static final int REQ_PLANSWEB = 7;
    private static final int REQ_BROWSER = 10;
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
        Upgrade.snapshot(this); // the first run of a newer version keeps a copy of the records first
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
                Diag.console(MainActivity.this, String.valueOf(m.messageLevel()), m.message(), m.sourceId(), m.lineNumber());
                return true;
            }
        });
        updater = new Updater(this);
        web.addJavascriptInterface(new Bridge(), "Android");
        setContentView(web);
        web.loadUrl(START);
        takeImport(getIntent());
        takeOpen(getIntent());
    }

    /** A notification asked for a screen of the app ("news"): the page opens it once it is ready. */
    private void takeOpen(Intent intent) {
        if (intent == null || !"news".equals(intent.getStringExtra("open"))) return;
        intent.removeExtra("open");
        runJs("window.openNews&&openNews()");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        takeImport(intent);
        takeOpen(intent);
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
            Diag.w(null, "write " + f.getName(), e);
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
                        Diag.w(MainActivity.this, "import " + uri, e);
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
        } else if (req == REQ_CLEAR) {
            String json = data == null ? null : data.getStringExtra(ClearanceActivity.EXTRA_JSON);
            runJs("window.onClearance&&onClearance(" + (json == null ? "{how:'cancelled',parts:[]}" : json) + ")");
        } else if (req == REQ_BROWSER) {
            String json = data == null ? null : data.getStringExtra(BrowserActivity.EXTRA_JSON);
            if (json != null && json.contains("xlsx")) runJs("window.onAttachment&&onAttachment()");
        } else if (req == REQ_PLANSWEB) {
            runJs("window.onPlansLogin&&onPlansLogin(true)");
        } else if (req == REQ_MYJYSK) {
            String json = data == null ? null : data.getStringExtra(MyjyskActivity.EXTRA_JSON);
            runJs("window.onMyjysk&&onMyjysk(" + (json == null ? "{how:'cancelled'}" : json) + ")");
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

    // the login typed on the first screen: checked with StoreFront once it is saved (answer: window.onLoginSaved)
    private boolean loginCheck;

    private void probeStore() {
        if (probing) return;
        probing = true;
        StoreProbe.run(this, (android.view.ViewGroup) getWindow().getDecorView(), new StoreProbe.Callback() {
            @Override
            public void done(boolean online, String counts) {
                probing = false;
                if (loginCheck) {
                    loginCheck = false;
                    if (AutoLogin.refused(MainActivity.this)) {
                        // StoreFront does not accept this password: forget it, the first screen asks again
                        Secret.clear(MainActivity.this);
                        AutoLogin.reset(MainActivity.this);
                        runJs("window.onLoginSaved&&onLoginSaved(false,'refused')");
                    } else {
                        runJs("window.onLoginSaved&&onLoginSaved(" + online + "," + org.json.JSONObject.quote(online ? "ok" : "offline") + ")");
                    }
                }
                runJs("window.onStoreStatus&&onStoreStatus(" + online + "," + org.json.JSONObject.quote(counts) + ")");
            }
        });
    }

    private boolean minusReading;

    private void readMinus() {
        if (minusReading) return;
        minusReading = true;
        MinusReader.run(this, (android.view.ViewGroup) getWindow().getDecorView(), new MinusReader.Callback() {
            @Override
            public void done(String how, org.json.JSONArray items) {
                minusReading = false;
                JSONObject o = new JSONObject();
                try {
                    o.put("how", how);
                    o.put("at", System.currentTimeMillis());
                    o.put("items", items == null ? new org.json.JSONArray() : items);
                } catch (Exception ignored) {
                }
                runJs("window.onMinus&&onMinus(" + o + ")");
            }
        });
    }

    private boolean mjReading;

    private void readMyjysk() {
        if (mjReading) return;
        mjReading = true;
        MyjyskProbe.run(this, (android.view.ViewGroup) getWindow().getDecorView(), new MyjyskProbe.Callback() {
            @Override
            public void done(String how, JSONObject data) {
                mjReading = false;
                JSONObject o = new JSONObject();
                try {
                    o.put("how", how);
                    o.put("at", System.currentTimeMillis());
                    if (data != null) o.put("data", data);
                } catch (Exception ignored) {
                }
                runJs("window.onMyjysk&&onMyjysk(" + o + ")");
            }
        });
    }

    private void showPlansLogin(String why) {
        float d = getResources().getDisplayMetrics().density;
        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        box.setPadding((int) (22 * d), (int) (8 * d), (int) (22 * d), 0);
        android.widget.TextView note = new android.widget.TextView(this);
        note.setText((why == null || why.isEmpty() ? "" : why + "\n\n") + "Isto korisničko ime i lozinka za MYJYSK, StoreFront i planograme. Kad te sistem odjavi, aplikacija se sama ponovo prijavi. Ostaju samo na ovom telefonu, šifrovani.");
        box.addView(note);
        final android.widget.EditText user = new android.widget.EditText(this);
        user.setHint("Korisničko ime");
        user.setSingleLine(true);
        user.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        String[] old = Secret.load(this);
        if (old != null) user.setText(old[0]);
        box.addView(user);
        final android.widget.EditText pass = new android.widget.EditText(this);
        pass.setHint("Lozinka");
        pass.setSingleLine(true);
        pass.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(pass);
        new android.app.AlertDialog.Builder(this)
            .setTitle("Prijava")
            .setView(box)
            .setPositiveButton("Prijavi se", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface di, int w) {
                    String u = user.getText().toString().trim(), p = pass.getText().toString();
                    boolean ok = !u.isEmpty() && !p.isEmpty() && Secret.save(MainActivity.this, u, p);
                    if (ok) {
                        AutoLogin.reset(MainActivity.this); // a new password: signing in by itself may try again
                        getSharedPreferences("sap", MODE_PRIVATE).edit().remove(SAP_KEPT_BAD).apply();
                    }
                    runJs("window.onPlansLogin&&onPlansLogin(" + ok + ")");
                }
            })
            .setNegativeButton("Odustani", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface di, int w) {
                    runJs("window.onPlansLogin&&onPlansLogin(false)");
                }
            })
            .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                @Override
                public void onCancel(android.content.DialogInterface di) {
                    runJs("window.onPlansLogin&&onPlansLogin(false)");
                }
            })
            .show();
    }

    /** Only well-formed lines: a 7-digit number in minus, its replacement, and comments of at most 50 characters. */
    private static JSONArray cleanApply(String json) {
        JSONArray out = new JSONArray();
        try {
            JSONArray in = new JSONArray(json);
            for (int i = 0; i < in.length() && out.length() < 100; i++) {
                JSONObject r = in.optJSONObject(i);
                if (r == null) continue;
                String num = r.optString("num"), target = r.optString("target");
                double qty = r.optDouble("qty", 0);
                if (!num.matches("\\d{7}") || !target.matches("\\d{7}") || num.equals(target) || !(qty < 0) || qty < -9999) continue;
                JSONObject c = new JSONObject();
                c.put("num", num);
                c.put("target", target);
                c.put("qty", qty == Math.rint(qty) ? (Object) (long) qty : (Object) qty);
                c.put("c1", cut50(r.optString("c1")));
                c.put("c2", cut50(r.optString("c2")));
                if (c.getString("c1").isEmpty() || c.getString("c2").isEmpty()) continue;
                out.put(c);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static String cut50(String s) {
        s = s == null ? "" : s.replaceAll("[\\r\\n]+", " ").trim();
        return s.length() > 50 ? s.substring(0, 50) : s;
    }

    private boolean applying;

    /** The kept sign-in did not pass StoreFront's check of the approver: ask for the password by hand until it is saved again. */
    private static final String SAP_KEPT_BAD = "keptBad";

    private void showMinusApply(final JSONArray items, final boolean adjustOnly) {
        showMinusApply(items, adjustOnly, false);
    }

    /**
     * Shows what will be sent and asks the employee to confirm. With a user name and password kept in the settings
     * (the same company sign-in) nothing has to be typed: the SAP HR number is the user StoreFront is signed in with,
     * the password is the kept one. "Upiši ručno" (or a kept password StoreFront did not accept) asks for both.
     * Nothing is sent before the button is pressed.
     */
    private void showMinusApply(final JSONArray items, final boolean adjustOnly, boolean byHand) {
        if (applying) return;
        String why = OpLog.blocked(this);
        if (why != null) {
            // a sending runs, or the last one has an unknown outcome: nothing new until it is checked
            runJs("window.onMinusApplied&&onMinusApplied({state:'locked',why:'" + why + "'})");
            return;
        }
        final android.content.SharedPreferences hp = getSharedPreferences("sap", MODE_PRIVATE);
        final String[] kept = Secret.load(this);
        final boolean useKept = !byHand && kept != null && !hp.getBoolean(SAP_KEPT_BAD, false);
        float d = getResources().getDisplayMetrics().density;
        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        box.setPadding((int) (22 * d), (int) (8 * d), (int) (22 * d), 0);
        StringBuilder sum = new StringBuilder();
        sum.append("Šalje se u StoreFront pod tvojim imenom:\n\n");
        if (!adjustOnly) {
            sum.append("1. Minus lista (vraćanje na 0):\n");
            for (int i = 0; i < items.length(); i++) {
                JSONObject x = items.optJSONObject(i);
                sum.append("   ").append(x.optString("num")).append(": ").append(x.opt("qty")).append(" → 0\n");
            }
            sum.append("\n2. ");
        }
        sum.append("Regulacija zalihe, kod 53:\n");
        for (int i = 0; i < items.length(); i++) {
            JSONObject x = items.optJSONObject(i);
            String q = String.valueOf(x.opt("qty"));
            sum.append("   ").append(x.optString("target")).append(": ").append(q).append(" kom\n");
        }
        sum.append("\nSvaki red ima komentar. Prije slanja aplikacija još jednom provjeri Minus listu i preskoči ono što se u međuvremenu promijenilo.");
        android.widget.TextView note = new android.widget.TextView(this);
        note.setText(sum.toString());
        note.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14);
        android.widget.ScrollView sc = new android.widget.ScrollView(this);
        sc.addView(note);
        box.addView(sc, new android.widget.LinearLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, (int) ((useKept ? 260 : 220) * d)));
        final android.widget.EditText user = new android.widget.EditText(this);
        final android.widget.EditText pass = new android.widget.EditText(this);
        if (useKept) {
            android.widget.TextView who = new android.widget.TextView(this);
            String hr = keptHr(hp, kept);
            who.setText("Potvrđuješ s prijavom iz postavki" + (hr.isEmpty() ? "" : " (SAP HR " + hr + ")") + ". Ništa ne treba kucati.");
            who.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13);
            who.setPadding(0, (int) (10 * d), 0, 0);
            box.addView(who);
        } else {
            user.setHint("SAP HR broj");
            user.setSingleLine(true);
            user.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
            user.setText(keptHr(hp, kept));
            box.addView(user);
            pass.setHint("Lozinka");
            pass.setSingleLine(true);
            pass.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
            box.addView(pass);
        }
        android.app.AlertDialog.Builder db = new android.app.AlertDialog.Builder(this)
            .setTitle((adjustOnly ? "Potvrdi regulaciju (" : "Potvrdi zamjene (") + items.length() + ")")
            .setView(box)
            .setPositiveButton("Potvrdi i pošalji", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface di, int w) {
                    if (applying) return; // one sending at a time: a second tap sends nothing
                    String u, p;
                    if (useKept) {
                        String[] now = Secret.load(MainActivity.this);
                        if (now == null) {
                            runJs("window.onMinusApplied&&onMinusApplied({state:'error',why:'empty'})");
                            return;
                        }
                        u = keptHr(hp, now); // empty: the page takes the user StoreFront is signed in with
                        p = now[1];
                    } else {
                        u = user.getText().toString().trim();
                        p = pass.getText().toString();
                        pass.setText("");
                        if (u.isEmpty() || p.isEmpty()) {
                            runJs("window.onMinusApplied&&onMinusApplied({state:'error',why:'empty'})");
                            return;
                        }
                        hp.edit().putString("hr", u).apply(); // the number only, never the password
                    }
                    // the record is written before anything is sent; no record, no sending
                    final String opId = OpLog.begin(MainActivity.this, adjustOnly ? "adjust" : "both", items);
                    if (opId == null) {
                        runJs("window.onMinusApplied&&onMinusApplied({state:'locked',why:'" + (OpLog.blocked(MainActivity.this) == null ? "record" : OpLog.blocked(MainActivity.this)) + "'})");
                        return;
                    }
                    applying = true;
                    runJs("window.onMinusApplying&&onMinusApplying()");
                    MinusApply.run(MainActivity.this, (android.view.ViewGroup) getWindow().getDecorView(), u, p, items, adjustOnly, new MinusApply.Callback() {
                        @Override
                        public void step(String st) {
                            OpLog.step(MainActivity.this, opId, st);
                        }

                        @Override
                        public void done(JSONObject result) {
                            applying = false;
                            JSONObject rec = OpLog.end(MainActivity.this, opId, result);
                            try {
                                if (rec != null) result.put("op", rec);
                            } catch (Exception ignored) {
                            }
                            try {
                                if (useKept) result.put("kept", true);
                                // the kept password was refused as approver: next time it is typed by hand (no second
                                // automatic try with the same password)
                                if (useKept && "auth".equals(result.optString("why"))) hp.edit().putBoolean(SAP_KEPT_BAD, true).apply();
                                else if ("ok".equals(result.optString("state"))) hp.edit().remove(SAP_KEPT_BAD).apply();
                            } catch (Exception ignored) {
                            }
                            runJs("window.onMinusApplied&&onMinusApplied(" + result + ")");
                        }
                    });
                }
            })
            .setNegativeButton("Odustani", null);
        if (useKept) {
            db.setNeutralButton("Upiši ručno", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface di, int w) {
                    showMinusApply(items, adjustOnly, true);
                }
            });
        }
        db.show();
    }

    /** The SAP HR number to use: the one typed last time, else the kept user name when it is a number, else "". */
    private static String keptHr(android.content.SharedPreferences hp, String[] kept) {
        String hr = hp.getString("hr", "");
        if (!hr.isEmpty()) return hr;
        return kept != null && kept[0].trim().matches("\\d{3,12}") ? kept[0].trim() : "";
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

        /**
         * The employee confirms the minus-list corrections in the app: a native dialog shows what will be sent; the
         * sign-in kept in the settings is used (or typed by hand). Answer: window.onMinusApplied.
         */
        @JavascriptInterface
        public void minusApply(final String itemsJson) {
            final JSONArray items = cleanApply(itemsJson);
            if (items.length() == 0) return;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    showMinusApply(items, false);
                }
            });
        }

        /** Copies of the records made before an update (Upgrade): JSON list. */
        @JavascriptInterface
        public String backups() {
            return Upgrade.list(MainActivity.this);
        }

        /** Puts a copy back, then the page loads again with it. */
        @JavascriptInterface
        public boolean restoreBackup(final String name) {
            boolean ok = Upgrade.restore(MainActivity.this, name);
            if (ok) {
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        web.reload();
                    }
                });
            }
            return ok;
        }

        /** A test build (Sandbox): nothing that writes leaves the phone; sendings are played. */
        @JavascriptInterface
        public boolean sandbox() {
            return Sandbox.on(MainActivity.this);
        }

        /** Test build only: how a played sending ends (see Sandbox.SIMS). */
        @JavascriptInterface
        public String sim() {
            return Sandbox.on(MainActivity.this) ? Sandbox.sim(MainActivity.this) : "";
        }

        @JavascriptInterface
        public void setSim(String s) {
            if (Sandbox.on(MainActivity.this)) Sandbox.setSim(MainActivity.this, String.valueOf(s));
        }

        /** The record of the last sending (see OpLog), or "" when there is none. */
        @JavascriptInterface
        public String minusOp() {
            JSONObject o = OpLog.read(MainActivity.this);
            if (o == null) return "";
            try {
                o.put("live", applying);
            } catch (Exception ignored) {
            }
            return o.toString();
        }

        /** The employee checked the sending with an unknown outcome in StoreFront: "done" or "notdone". */
        @JavascriptInterface
        public String minusOpResolve(String id, String how) {
            JSONObject o = OpLog.resolve(MainActivity.this, String.valueOf(id), String.valueOf(how));
            return o == null ? "" : o.toString();
        }

        /** Only Regulacija zalihe, for lines whose Minus lista part went through earlier. Answer: window.onMinusApplied. */
        @JavascriptInterface
        public void minusApplyAdjust(final String itemsJson) {
            final JSONArray items = cleanApply(itemsJson);
            if (items.length() == 0) return;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    showMinusApply(items, true);
                }
            });
        }

        /** Opens a StoreFront page to work in: "minus" (Minus lista) or "adjust" (Regulacija zalihe). */
        @JavascriptInterface
        public void storefrontPage(final String page) {
            if (!"minus".equals(page) && !"adjust".equals(page)) return;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(MainActivity.this, StorefrontActivity.class);
                    i.putExtra(StorefrontActivity.EXTRA_PAGE, page);
                    startActivity(i);
                }
            });
        }

        /** Puts a short text (a prepared comment) on the phone's clipboard. */
        @JavascriptInterface
        public void copyText(final String text) {
            if (text == null || text.length() > 500) return;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    android.content.ClipboardManager cb = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cb != null) cb.setPrimaryClip(android.content.ClipData.newPlainText("Komentar", text));
                }
            });
        }

        /** Reads the store's minus list from StoreFront (only reads). Answer: window.onMinus. */
        @JavascriptInterface
        public void minus() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    readMinus();
                }
            });
        }

        /** Background look at the order numbers: on/off, and the numbers of the last full read. */
        @JavascriptInterface
        public void watch(final boolean on, final String base, final boolean ask) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (ask && on && Build.VERSION.SDK_INT >= 33
                            && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
                        }
                        OrderWatch.set(MainActivity.this, on, base);
                    } catch (Throwable e) {
                        Log.w(TAG, "watch: " + e);
                    }
                }
            });
        }

        /** The last crash of the app (stack trace), or an empty string. */
        @JavascriptInterface
        public String lastCrash() {
            try {
                java.io.File f = App.crashFile(MainActivity.this);
                if (!f.isFile()) return "";
                java.io.FileInputStream in = new java.io.FileInputStream(f);
                try {
                    byte[] b = new byte[(int) Math.min(f.length(), 4000)];
                    int n = in.read(b);
                    return n > 0 ? new String(b, 0, n, "UTF-8") : "";
                } finally {
                    in.close();
                }
            } catch (Throwable e) {
                return "";
            }
        }

        @JavascriptInterface
        public void clearCrash() {
            try {
                App.crashFile(MainActivity.this).delete();
            } catch (Throwable ignored) {
            }
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
            if (!safe(name) || text == null || OpLog.FILE.equals(name)) return false; // the sending record is the app's own
            return writeAtomic(new File(dir("data"), name), text.getBytes(StandardCharsets.UTF_8));
        }

        @JavascriptInterface
        public boolean deleteText(String name) {
            if (!safe(name) || OpLog.FILE.equals(name)) return false;
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

        /** Pictures from StoreFront for articles in no planogram: [{num, url}], answer window.onSfPictures. */
        @JavascriptInterface
        public void fetchSfPictures(String list) {
            SfPictures.fetch(MainActivity.this, list);
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

        /** Reads the articles in stock with the given status codes (JSON array) in a product group. Answer: window.onClearance. */
        @JavascriptInterface
        public void clearance(final String statuses, final String group) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(MainActivity.this, ClearanceActivity.class);
                    i.putExtra(ClearanceActivity.EXTRA_STATUSES, statuses);
                    i.putExtra(ClearanceActivity.EXTRA_GROUP, group);
                    startActivityForResult(i, REQ_CLEAR);
                }
            });
        }

        /** True when this build knows the MYJYSK address. */
        @JavascriptInterface
        public boolean myjyskOn() {
            return MyjyskReader.enabled(MainActivity.this);
        }

        /**
         * Who the employee is in MYJYSK (name, number). Never built in any more: the page keeps it in its settings on
         * the phone (filled once from StoreFront's own user details, changeable in Postavke). Kept for older pages.
         */
        @JavascriptInterface
        public String myjyskMe() {
            return "";
        }

        /** Reads the MYJYSK tasks and news: hidden (visible = false) or on the sign-in screen. Answer: window.onMyjysk. */
        @JavascriptInterface
        public void myjysk(final boolean visible) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if (!visible) {
                        readMyjysk();
                        return;
                    }
                    Intent i = new Intent(MainActivity.this, MyjyskActivity.class);
                    i.putExtra(MyjyskActivity.EXTRA_MODE, "login");
                    startActivityForResult(i, REQ_MYJYSK);
                }
            });
        }

        /** A StoreFront job (see assets/store-task.js): find, article, top, smdm, smset. Answer: window.onStoreTask. */
        @JavascriptInterface
        public void storeTask(final String argJson) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    StoreTask.run(MainActivity.this, (android.view.ViewGroup) getWindow().getDecorView(), argJson, new StoreTask.Callback() {
                        @Override
                        public void done(JSONObject answer) {
                            runJs("window.onStoreTask&&onStoreTask(" + answer + ")");
                        }
                    });
                }
            });
        }

        /** The weekly AR rating in MYJYSK (see assets/myjysk-ar.js): reads the form or sends the answers. Answer: window.onMjAr. */
        @JavascriptInterface
        public void myjyskAr(final String argJson) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    MyjyskTask.run(MainActivity.this, (android.view.ViewGroup) getWindow().getDecorView(), argJson, new MyjyskTask.Callback() {
                        @Override
                        public void done(JSONObject answer) {
                            runJs("window.onMjAr&&onMjAr(" + answer + ")");
                        }
                    });
                }
            });
        }

        /** Opens one MYJYSK task or news article ("/ui/tasks/distrtask/123", "/ui/news/articles/456") for reading. */
        @JavascriptInterface
        public void myjyskOpen(final String path) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    // the app's own browser (the reader for news); an Excel attachment comes back as window.onAttachment
                    Intent i = new Intent(MainActivity.this, BrowserActivity.class);
                    i.putExtra(BrowserActivity.EXTRA_PATH, path);
                    startActivityForResult(i, REQ_BROWSER);
                }
            });
        }

        /** Downloads planogram PDFs into the inbox (JSON list, see PlanDownload). Progress and answer: window.onPlanDl. */
        @JavascriptInterface
        public void downloadPlans(final String json) {
            final String host;
            try {
                host = new StringBuilder(getString(R.string.plans_host)).reverse().toString().trim();
            } catch (Exception e) {
                runJs("window.onPlanDl&&onPlanDl({done:true,files:[],why:'off'})");
                return;
            }
            io.execute(new Runnable() {
                @Override
                public void run() {
                    JSONArray in;
                    try {
                        in = new JSONArray(json);
                    } catch (Exception e) {
                        in = new JSONArray();
                    }
                    JSONArray out;
                    try {
                        out = PlanDownload.run(host, dir("inbox"), in, Secret.load(MainActivity.this), new PlanDownload.Progress() {
                            @Override
                            public void on(int i, int n, String name) {
                                runJs("window.onPlanDl&&onPlanDl({i:" + i + ",n:" + n + ",name:" + JSONObject.quote(name) + "})");
                            }
                        });
                    } catch (PlanDownload.NeedLogin e) {
                        runJs("window.onPlanDl&&onPlanDl({done:true,files:[],login:" + JSONObject.quote(e.kind) + ",detail:" + JSONObject.quote(e.detail) + ",kept:" + (Secret.load(MainActivity.this) != null) + "})");
                        return;
                    }
                    runJs("window.onPlanDl&&onPlanDl({done:true,files:" + out + "})");
                }
            });
        }

        /**
         * Asks for the user name and password of the planogram server in a native dialog of the app (the page never
         * sees them) and keeps them encrypted on the phone. Answer: window.onPlansLogin(true|false).
         */
        @JavascriptInterface
        public void plansLogin(final String why) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    showPlansLogin(why);
                }
            });
        }

        /** The planogram server's own sign-in page, on the whole screen; afterwards window.onPlansLogin(true). */
        @JavascriptInterface
        public void plansWeb(final String url) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(MainActivity.this, MyjyskActivity.class);
                    i.putExtra(MyjyskActivity.EXTRA_MODE, "plans");
                    i.putExtra(MyjyskActivity.EXTRA_URL, url);
                    startActivityForResult(i, REQ_PLANSWEB);
                }
            });
        }

        /**
         * The login typed on the app's first screen: kept encrypted like the one in the settings, then checked with
         * StoreFront. Answer: window.onLoginSaved(ok, why): ok | refused | offline | empty | save.
         */
        @JavascriptInterface
        public void saveLogin(final String user, final String pass) {
            final String u = user == null ? "" : user.trim();
            final String p = pass == null ? "" : pass;
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if (u.isEmpty() || p.isEmpty() || u.length() > 60 || p.length() > 200) {
                        runJs("window.onLoginSaved&&onLoginSaved(false,'empty')");
                        return;
                    }
                    if (!Secret.save(MainActivity.this, u, p)) {
                        runJs("window.onLoginSaved&&onLoginSaved(false,'save')");
                        return;
                    }
                    AutoLogin.reset(MainActivity.this);
                    getSharedPreferences("sap", MODE_PRIVATE).edit().remove(SAP_KEPT_BAD).apply();
                    loginCheck = true;
                    probing = false; // a check that was running answers for the old login: start again with the new one
                    probeStore();
                }
            });
        }

        /** Forgets the kept sign-in of the planogram server. */
        @JavascriptInterface
        public void plansLogout() {
            Secret.clear(MainActivity.this);
            AutoLogin.reset(MainActivity.this);
        }

        /** The kept sign-in: "none", "ok", or "refused" (the last automatic sign-in was not accepted). */
        @JavascriptInterface
        public String loginLast() {
            return AutoLogin.last(MainActivity.this);
        }

        @JavascriptInterface
        public String loginState() {
            if (Secret.load(MainActivity.this) == null) return "none";
            return AutoLogin.refused(MainActivity.this) ? "refused" : "ok";
        }

        @JavascriptInterface
        public boolean plansLoginKept() {
            return Secret.load(MainActivity.this) != null;
        }

        /** The 8:00 reading on or off; ask = ask for the notification permission when it is missing. */
        @JavascriptInterface
        public void myjyskDaily(final boolean on, final boolean ask) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (ask && on && Build.VERSION.SDK_INT >= 33
                            && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
                        }
                        MyjyskDaily.set(MainActivity.this, on);
                    } catch (Exception e) {
                        Diag.w(MainActivity.this, "myjysk daily", e);
                    }
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
                        Diag.w(MainActivity.this, "settings", e);
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
