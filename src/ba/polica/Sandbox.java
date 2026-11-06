package ba.polica;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Test builds (build.sh TEST=1 or RC=1, string resource "sandbox" = 1) never change anything in StoreFront or MYJYSK.
 *  1. Every request of a page in the app that could write is answered on the phone and never leaves it (policy():
 *     deny unless known to be harmless), from every WebView of the app and from service workers.
 *  2. The sending scripts (Minus lista, Regulacija, SM/DM, AR) do not even try: they play the outcome the tester
 *     picked in Postavke → TEST (sim), so every ending of a sending can be tried on the phone without real data.
 * A release build (sandbox empty) is not affected by any of this.
 */
final class Sandbox {
    static final String[] SIMS = {"ok", "drop-minus", "drop-adjust", "500-minus", "422-adjust", "auth", "hang-minus", "hang-adjust", "slow"};

    private Sandbox() {
    }

    static boolean on(Context c) {
        try {
            return "1".equals(c.getString(R.string.sandbox));
        } catch (Exception e) {
            return false;
        }
    }

    static String sim(Context c) {
        String s = c.getSharedPreferences("sandbox", Context.MODE_PRIVATE).getString("sim", "ok");
        for (String x : SIMS) if (x.equals(s)) return s;
        return "ok";
    }

    static void setSim(Context c, String s) {
        for (String x : SIMS) {
            if (x.equals(s)) {
                c.getSharedPreferences("sandbox", Context.MODE_PRIVATE).edit().putString("sim", s).apply();
                return;
            }
        }
    }

    // what a request may do in a test build, decided by "deny unless known to be harmless" (see policy())
    static final String ALLOW = "allow", BLOCK = "block";
    // a path segment that is exactly one of these names an action: a GET carrying it may change data
    private static final java.util.Set<String> VERBS = new java.util.HashSet<>(java.util.Arrays.asList(
        "complete", "approve", "delete", "remove", "cancel", "confirm", "submit", "close", "finish", "reset", "update", "save",
        "create", "assign", "accept", "reject", "start", "startconduct", "post", "send", "set", "adjust", "mark", "archive",
        "restore", "upload", "import", "publish", "sign", "book", "reserve", "release", "transfer", "pay", "print", "fieldvalue",
        "write", "edit", "change", "modify", "add", "insert", "move", "lock", "unlock", "validate", "execute", "run", "apply"));
    // ... and a segment that BEGINS with one of these (completeVisit, markAsRead, deleteAll) as well
    private static final String[] VERB_STARTS = {"complete", "approve", "delete", "remove", "cancel", "confirm", "submit", "startconduct", "markas", "fieldvalue"};

    static boolean actionWord(String seg) {
        if (seg.isEmpty() || seg.matches("[0-9a-f-]+")) return false;
        if (VERBS.contains(seg)) return true;
        for (String v : VERB_STARTS) if (seg.startsWith(v)) return true;
        return false;
    }

    /**
     * The rule for one request in a test build. Not a list of known dangerous addresses but the other way round:
     *  - anything other than GET/HEAD/OPTIONS (POST, PUT, PATCH, DELETE, forms, beacons) is held back on EVERY host,
     *    except (a) the company sign-in: the hosts idp./login./sts./adfs. and Microsoft's, and on StoreFront's and
     *    MYJYSK's own hosts only the sign-in gateway (F5: /my.policy, /my.logon…, /vdesk/; or a path segment
     *    login/logout/oauth/oauth2/saml/saml2/signin/sso/auth outside /api/), and (b) the reads that are POSTs:
     *    StoreFront's article search (/api/v1/article/search) and MYJYSK's search API (/searchapi/);
     *  - a GET to StoreFront or MYJYSK whose path or query names an action (complete, approve, delete, update, ...) is
     *    held back too, because some systems change data with a GET (MYJYSK completes a store visit like that).
     */
    static String policy(String method, String host, String path, String query, String storefront, String myjysk) {
        String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        String p = path == null ? "/" : path.toLowerCase(Locale.ROOT);
        String q = query == null ? "" : query.toLowerCase(Locale.ROOT);
        boolean ours = h.equals(storefront.toLowerCase(Locale.ROOT)) || (!myjysk.isEmpty() && h.equals(myjysk.toLowerCase(Locale.ROOT)));
        boolean read = m.equals("GET") || m.equals("HEAD") || m.equals("OPTIONS");
        if (read) {
            if (!ours) return ALLOW;
            for (String seg : p.split("[/;]+")) if (actionWord(seg)) return BLOCK;
            // in the query only an explicit action (action=delete, op=complete, cmd=..., method=post) counts
            for (String kv : q.split("&")) {
                int e = kv.indexOf('=');
                if (e > 0 && kv.substring(0, e).matches("action|op|cmd|command|method|do") && actionWord(kv.substring(e + 1))) return BLOCK;
            }
            return ALLOW;
        }
        if (h.startsWith("idp.") || h.startsWith("login.") || h.startsWith("sts.") || h.startsWith("adfs.")
            || h.endsWith(".microsoftonline.com") || h.equals("login.microsoft.com") || h.endsWith(".login.microsoft.com")) return ALLOW;
        if (!ours) return BLOCK;
        if (p.startsWith("/my.policy") || p.startsWith("/my.logon") || p.startsWith("/vdesk/")) return ALLOW;
        if (!p.startsWith("/api/")) {
            for (String seg : p.split("/")) {
                if (seg.matches("login|logout|oauth|oauth2|saml|saml2|signin|signin-oidc|sso|auth")) return ALLOW;
            }
        }
        if (h.equals(storefront.toLowerCase(Locale.ROOT)) && (p.equals("/api/v1/article/search") || p.equals("/api/v1/article/search/"))) return ALLOW;
        if (!myjysk.isEmpty() && h.equals(myjysk.toLowerCase(Locale.ROOT)) && p.startsWith("/searchapi/")) return ALLOW;
        return BLOCK;
    }

    /** Older name, kept for the tests: true when the request is held back. */
    static boolean blocks(String method, String host, String path, String storefront, String myjysk) {
        int i = path == null ? -1 : path.indexOf('?');
        return BLOCK.equals(policy(method, host, i < 0 ? path : path.substring(0, i), i < 0 ? "" : path.substring(i + 1), storefront, myjysk));
    }

    /**
     * Test builds: run at the start of every page. Closes the ways out that the request guard cannot see
     * (WebSocket, and the Beacon API on old WebViews). Best effort only: the guard below is the real stop.
     */
    static void page(Context c, android.webkit.WebView v) {
        if (c == null || v == null || !on(c)) return;
        try {
            v.evaluateJavascript("(function(){try{window.WebSocket=function(){throw new Error('TEST: WebSocket zatvoren')};"
                + "if(navigator.sendBeacon)navigator.sendBeacon=function(){return false};}catch(e){}})()", null);
        } catch (Exception ignored) {
        }
    }

    /** For WebViewClient.shouldInterceptRequest: null = load normally; else the blocked answer. */
    static WebResourceResponse guard(Context c, WebResourceRequest r) {
        if (c == null || r == null || !on(c)) return null;
        Uri u = r.getUrl();
        String sf = new StringBuilder(c.getString(R.string.storefront_host)).reverse().toString().trim();
        String mj = new StringBuilder(c.getString(R.string.myjysk_host)).reverse().toString().trim();
        if (!BLOCK.equals(policy(r.getMethod(), u.getHost(), u.getPath(), u.getQuery(), sf, mj))) return null;
        Diag.w(c, "TEST: blokirano " + r.getMethod() + " " + u.getHost() + u.getPath(), null);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("application/json", "utf-8", 403, "Blocked in TEST", h,
            new ByteArrayInputStream("{\"message\":\"TEST verzija: ništa se ne šalje u StoreFront ni MYJYSK\"}".getBytes(StandardCharsets.UTF_8)));
    }
}
