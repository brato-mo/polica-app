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
 *  1. Every request of an app page that would write is answered on the phone, it never leaves it: any request other
 *     than GET/HEAD/OPTIONS to an /api/ address of StoreFront or MYJYSK, except searches (StoreFront's article search
 *     is a POST that only reads). Sign-in pages are other addresses and work as usual.
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

    /** True when this request must not leave the phone in a test build (see 1. above). */
    static boolean blocks(String method, String host, String path, String storefront, String myjysk) {
        String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        if (m.equals("GET") || m.equals("HEAD") || m.equals("OPTIONS")) return false;
        if (host == null || path == null) return false;
        boolean ours = host.equalsIgnoreCase(storefront) || (!myjysk.isEmpty() && host.equalsIgnoreCase(myjysk));
        if (!ours) return false;
        String p = path.toLowerCase(Locale.ROOT);
        if (!p.startsWith("/api/")) return false;
        return !p.contains("/search");
    }

    /** For WebViewClient.shouldInterceptRequest: null = load normally; else the blocked answer. */
    static WebResourceResponse guard(Context c, WebResourceRequest r) {
        if (c == null || r == null || !on(c)) return null;
        Uri u = r.getUrl();
        String sf = new StringBuilder(c.getString(R.string.storefront_host)).reverse().toString().trim();
        String mj = new StringBuilder(c.getString(R.string.myjysk_host)).reverse().toString().trim();
        if (!blocks(r.getMethod(), u.getHost(), u.getPath(), sf, mj)) return null;
        Diag.w(c, "TEST: blokirano " + r.getMethod() + " " + u.getPath(), null);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("application/json", "utf-8", 403, "Blocked in TEST", h,
            new ByteArrayInputStream("{\"message\":\"TEST verzija: ništa se ne šalje u StoreFront ni MYJYSK\"}".getBytes(StandardCharsets.UTF_8)));
    }
}
