package ba.polica;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * Signs in again by itself when the store systems (StoreFront, MYJYSK, planogram server) send a WebView of the app to
 * the company's sign-in page because the session ran out. It uses the user name and password the employee typed in the
 * app's settings, kept encrypted on the phone (Secret), and fills them in ONLY on the company's own sign-in page: the
 * exact host, https, checked again right before filling. If the sign-in page comes back right after a try, the
 * password was not accepted: nothing more is tried until it is typed again in the settings (no account lock-out).
 */
final class AutoLogin {
    private static final String PREFS = "autologin";
    private static final long AGAIN_MS = 60000; // the sign-in page again within this time after a try: rejected

    // when each WebView last sent the form: only the same WebView coming back to the form means a refused password
    // (two WebViews may reach the sign-in page at the same moment)
    private static final java.util.Map<WebView, Long> TRIED = new java.util.WeakHashMap<>();

    private AutoLogin() {
    }

    /** The sign-in host, from the build's StoreFront host: "idp." + its domain ("a.example.com" -> "idp.example.com"). */
    static String host(Context c) {
        try {
            String sf = new StringBuilder(c.getString(R.string.storefront_host)).reverse().toString().trim().toLowerCase();
            int i = sf.indexOf('.');
            if (i < 1 || sf.indexOf('.', i + 1) < 0) return "";
            return "idp" + sf.substring(i);
        } catch (Exception e) {
            return "";
        }
    }

    static boolean isLoginPage(Context c, String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            String h = host(c);
            return !h.isEmpty() && "https".equals(u.getScheme()) && h.equalsIgnoreCase(u.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    private static String rev(Context c, int id) {
        try {
            return new StringBuilder(c.getString(id)).reverse().toString().trim().toLowerCase();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * The store systems themselves (StoreFront, MYJYSK, planogram server, from the build). StoreFront has a sign-in
     * form of its own in front of it (a gateway page "Secure Logon"); on these hosts a form is filled only when the
     * page really is that gateway form (form id auth_form with a password field), never on an ordinary page.
     */
    static boolean isSystemPage(Context c, String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            if (!"https".equals(u.getScheme()) || u.getHost() == null) return false;
            String h = u.getHost().toLowerCase();
            for (int id : new int[] {R.string.storefront_host, R.string.myjysk_host, R.string.plans_host}) {
                String x = rev(c, id);
                if (!x.isEmpty() && x.equals(h)) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** A user name and password are kept and were not refused: worth waiting a moment on a sign-in page. */
    static boolean ready(Context c) {
        return !prefs(c).getBoolean("refused", false) && Secret.load(c) != null;
    }

    /** The last try was refused (shown in the settings until the password is typed again). */
    static boolean refused(Context c) {
        return prefs(c).getBoolean("refused", false) && Secret.load(c) != null;
    }

    /** New user name and password saved: try again. */
    static void reset(Context c) {
        prefs(c).edit().clear().apply();
    }

    /** Call from onPageFinished of every WebView that opens the store systems. */
    static void onPage(final Context ctx, final WebView w, final String url) {
        if (w == null || url == null) return;
        final boolean idp = isLoginPage(ctx, url);
        if (!idp && !isSystemPage(ctx, url)) return;
        final Context c = ctx.getApplicationContext();
        final SharedPreferences p = prefs(c);
        if (p.getBoolean("refused", false)) return;
        final String[] cred = Secret.load(c);
        if (cred == null) return;
        // the page draws its form a moment after loading; fill it once it is there
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                String now;
                try {
                    now = w.getUrl();
                } catch (Exception e) {
                    return; // the WebView is gone
                }
                if (idp ? !isLoginPage(c, now) : !isSystemPage(c, now)) return; // left the page meanwhile: fill nothing
                // back on the form right after a try: only a refused password brings the form back (pages of the
                // sign-in host without the form, on the way back after a good sign-in, do not count)
                Long t = TRIED.get(w);
                final boolean recent = t != null && System.currentTimeMillis() - t < AGAIN_MS;
                // on the systems' own hosts only their gateway sign-in form counts (strict), and nothing else is clicked
                String js = "(function(u,p,recent,strict){try{var f=document.getElementById('auth_form')||(strict?null:document.querySelector('form'));"
                    + "if(strict&&!(f&&f.querySelector('input[type=password]')))return 'none';"
                    + "var a=f&&(f.querySelector('input[name=username]')||f.querySelector('input[type=text],input[type=email]'));"
                    + "var b=f&&f.querySelector('input[type=password]');"
                    + "if(!a||!b){var l=[].slice.call(document.querySelectorAll('a[href]')).filter(function(x){return x.host===location.host&&/new session|start|continue|nastav|nov/i.test(x.textContent)})[0];"
                    + "if(l&&!recent&&!strict){l.click();return 'link'}return 'none'}"
                    + "if(recent)return 'again';"
                    + "function put(e,v){var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,v);"
                    + "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}"
                    + "put(a,u);put(b,p);var s=f.querySelector('[type=submit],button');if(s)s.click();else f.submit();return 'sent'}catch(e){return 'error'}})("
                    + JSONObject.quote(cred[0]) + "," + JSONObject.quote(cred[1]) + "," + recent + "," + !idp + ")";
                try {
                    w.evaluateJavascript(js, new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            if (v == null) return;
                            if (v.contains("sent")) TRIED.put(w, System.currentTimeMillis());
                            else if (v.contains("again")) p.edit().putBoolean("refused", true).apply();
                        }
                    });
                } catch (Exception ignored) {
                }
            }
        }, 400);
    }
}
