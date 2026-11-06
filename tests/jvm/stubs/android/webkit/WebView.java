package android.webkit;
import android.os.Handler;
/**
 * A scripted page. Page.current decides what the injected minus-apply.js "does": it is the real script's own
 * sequence of window.__mx values (captured from assets/minus-apply.js), played over time.
 */
public class WebView extends android.view.View {
    public interface Page { void injected(String script); String mx(); boolean dead(); }
    public static volatile Page current; public static volatile boolean neverLoads; public static volatile String lastInjected;
    public static final java.util.List<WebView> made = new java.util.concurrent.CopyOnWriteArrayList<>();
    final android.content.Context ctx; String url; int progress; WebViewClient client; public boolean destroyed;
    final Handler h = new Handler();
    public WebView(android.content.Context c) { ctx = c; made.add(this); }
    public android.content.Context getContext() { return ctx; }
    public WebSettings getSettings() { return new WebSettings(); }
    public void setWebViewClient(WebViewClient c) { client = c; }
    public void loadUrl(String u) {
        if (neverLoads) { url = "https://login.example.test/"; progress = 100; return; }
        h.postDelayed(() -> { url = u; progress = 100; if (client != null) client.onPageFinished(this, u); }, 300);
    }
    public String getUrl() { return url; } public int getProgress() { return progress; }
    public void evaluateJavascript(String s, ValueCallback<String> cb) {
        if (destroyed) return;
        Page p = current;
        if (s.startsWith("window.__mx=null")) { lastInjected = s; if (p != null) p.injected(s); return; }
        if (p != null && p.dead()) return; // a page that stopped answering: the callback never comes
        String v = p == null ? null : p.mx();
        if (cb != null) h.post(() -> cb.onReceiveValue(v == null ? "null" : org.json.JSONObject.quote(v)));
    }
    public void destroy() { destroyed = true; }
}
