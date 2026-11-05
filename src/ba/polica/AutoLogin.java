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

    // when each WebView last sent the form, per sign-in host: only the same form (same WebView, same host) coming back
    // means a refused password. One sign-in goes through two forms in a row (StoreFront's gateway, then the company's
    // sign-in page), and two WebViews may reach a sign-in page at the same moment.
    private static final java.util.Map<WebView, java.util.Map<String, Long>> TRIED = new java.util.WeakHashMap<>();
    // how many times in a row the form came back without a word about a wrong password (per WebView and host): the
    // sign-in host sometimes shows its form again after a good try ("session could not be established"); one more try
    // is made then, never more
    private static final java.util.Map<WebView, java.util.Map<String, Integer>> BACK = new java.util.WeakHashMap<>();
    private static final int VERSION = 3; // a "refused" kept by an older version may be wrong: forgotten once

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
        SharedPreferences p = c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (p.getInt("v", 0) < VERSION) p.edit().clear().putInt("v", VERSION).apply();
        return p;
    }

    /** A user name and password are kept and were not refused: worth waiting a moment on a sign-in page. */
    static boolean ready(Context c) {
        return !prefs(c).getBoolean("refused", false) && Secret.load(c) != null;
    }

    /** The last try was refused (shown in the settings until the password is typed again). */
    static boolean refused(Context c) {
        return prefs(c).getBoolean("refused", false) && Secret.load(c) != null;
    }

    /** What the last automatic sign-in did, for the settings: "<time>|<what>|<page>". */
    static String last(Context c) {
        return prefs(c).getString("last", "");
    }

    private static void note(SharedPreferences p, String what, String host) {
        p.edit().putString("last", System.currentTimeMillis() + "|" + what + "|" + (host == null ? "" : host)).apply();
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
        final String host = Uri.parse(url).getHost();
        if (p.getBoolean("refused", false)) {
            if (idp) note(p, "stopped", host);
            return;
        }
        final String[] cred = Secret.load(c);
        if (cred == null) {
            if (idp) note(p, "nologin", host);
            return;
        }
        final Handler ui = new Handler(Looper.getMainLooper());
        final int[] tries = {0};
        // the page draws its form a moment after loading; look again a few times until it is there
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                final Runnable again = this;
                String now;
                try {
                    now = w.getUrl();
                } catch (Exception e) {
                    return; // the WebView is gone
                }
                if (idp ? !isLoginPage(c, now) : !isSystemPage(c, now)) return; // left the page meanwhile: fill nothing
                // back on the form right after a try: only a refused password brings the form back (pages of the
                // sign-in host without the form, on the way back after a good sign-in, do not count)
                java.util.Map<String, Long> per = TRIED.get(w);
                Long t = per == null ? null : per.get(host);
                final boolean recent = t != null && System.currentTimeMillis() - t < AGAIN_MS;
                // on the systems' own hosts only their gateway sign-in form counts (strict), and nothing else is clicked
                String js = "(function(u,p,recent,strict){try{var f=document.getElementById('auth_form')||(strict?null:document.querySelector('form'));"
                    + "if(strict&&!(f&&f.querySelector('input[type=password]')))return 'none';"
                    + "var a=f&&(f.querySelector('input[name=username]')||f.querySelector('input[type=text],input[type=email]'));"
                    + "var b=f&&f.querySelector('input[type=password]');"
                    + "if(!a||!b){var l=[].slice.call(document.querySelectorAll('a[href]')).filter(function(x){return x.host===location.host&&/new session|start|continue|nastav|nov/i.test(x.textContent)})[0];"
                    + "if(l&&!recent&&!strict){l.click();return 'link'}return 'none'}"
                    + "if(recent){var t=(document.body&&document.body.innerText||'').toLowerCase();"
                    + "return /not correct|incorrect|invalid|wrong|denied|neispravn|pogre[sš]n|nije ta[cč]n|locked|zaklju/.test(t)?'again-bad':'again'}"
                    + "function put(e,v){var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,v);"
                    + "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}"
                    + "put(a,u);put(b,p);var s=f.querySelector('[type=submit],button');if(s)s.click();else f.submit();return 'sent'}catch(e){return 'error'}})("
                    + JSONObject.quote(cred[0]) + "," + JSONObject.quote(cred[1]) + "," + recent + "," + !idp + ")";
                try {
                    w.evaluateJavascript(js, new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            if (v == null) return;
                            if (v.contains("sent")) {
                                note(p, "sent", host);
                                java.util.Map<String, Long> m = TRIED.get(w);
                                if (m == null) TRIED.put(w, m = new java.util.HashMap<>());
                                m.put(host, System.currentTimeMillis());
                            } else if (v.contains("again")) {
                                java.util.Map<String, Integer> b = BACK.get(w);
                                if (b == null) BACK.put(w, b = new java.util.HashMap<>());
                                Integer n = b.get(host);
                                if (!v.contains("again-bad") && (n == null || n < 1)) {
                                    // no word about a wrong password: the page only came back; one more try
                                    b.put(host, 1);
                                    java.util.Map<String, Long> m = TRIED.get(w);
                                    if (m != null) m.remove(host);
                                    note(p, "retry", host);
                                    ui.postDelayed(again, 1200);
                                    return;
                                }
                                if (v.contains("again-bad")) {
                                    // the page says the password is wrong: stop trying, the employee types it again
                                    p.edit().putBoolean("refused", true).apply();
                                    note(p, "refused", host);
                                } else {
                                    // the form came back twice without a word about the password (the gateway's own
                                    // hiccup, or two pages signing in at once): no more tries here, but the kept
                                    // login stays good
                                    note(p, "stuck", host);
                                }
                            } else if (v.contains("none") && ++tries[0] < 5) {
                                ui.postDelayed(again, 700); // the form is not drawn yet
                            } else if (v.contains("none") && idp) {
                                note(p, "noform", host); // on the sign-in page, but no form to fill was found
                            } else if (v.contains("link")) {
                                note(p, "link", host);
                            } else if (v.contains("error")) {
                                note(p, "error", host);
                            }
                        }
                    });
                } catch (Exception ignored) {
                }
            }
        }, 400);
    }
}
