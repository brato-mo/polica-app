package ba.polica;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.UUID;

/**
 * Downloads planogram PDFs from the planogram server that the store concept pages link to. Only that server is
 * allowed (its address comes from the build, R.string.plans_host); http is turned into https. A file that is the same
 * as last time (same fingerprint, or "not modified" from the server) is not kept, so only changed planograms are read.
 */
final class PlanDownload {
    interface Progress {
        void on(int i, int n, String name);
    }

    private static final long MAX = 80L * 1024 * 1024;

    private PlanDownload() {
    }

    /**
     * in: [{url, name, sha, etag, lm}] (sha/etag/lm from the last download, may be empty).
     * out: [{url, name, status: new|same|error, file, size, sha, etag, lm, why}]
     */
    /** Thrown when the server wants a sign-in; the whole download stops and the app asks for it. */
    static final class NeedLogin extends Exception {
        final String kind; // auth: the server asks for a user and password itself; page: it sends to a sign-in page
        final String detail;

        NeedLogin(String kind, String detail) {
            super(kind);
            this.kind = kind;
            this.detail = detail;
        }
    }

    static JSONArray run(String host, File inbox, JSONArray in, String[] login, Progress p) throws NeedLogin {
        JSONArray out = new JSONArray();
        for (int i = 0; i < in.length(); i++) {
            JSONObject f = in.optJSONObject(i);
            if (f == null) continue;
            String name = f.optString("name", "planogram") ;
            if (p != null) p.on(i, in.length(), name);
            JSONObject r = new JSONObject();
            try {
                r.put("url", f.optString("url"));
                r.put("name", name);
                one(host, inbox, f, r, login);
            } catch (NeedLogin e) {
                throw e;
            } catch (Exception e) {
                try {
                    r.put("status", "error");
                    r.put("why", String.valueOf(e.getMessage()));
                } catch (Exception ignored) {
                }
            }
            out.put(r);
        }
        return out;
    }

    private static void one(String host, File inbox, JSONObject f, JSONObject r, String[] login) throws Exception {
        URL u = new URL(f.optString("url"));
        HttpURLConnection c = null;
        for (int hop = 0; hop < 6; hop++) {
            if (!host.equalsIgnoreCase(u.getHost())) throw new Exception("drugi server");
            if ("http".equals(u.getProtocol())) u = new URL("https", u.getHost(), u.getFile());
            if (!"https".equals(u.getProtocol())) throw new Exception("nije https");
            c = (HttpURLConnection) u.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setRequestProperty("Accept", "application/pdf,*/*");
            String cookies = android.webkit.CookieManager.getInstance().getCookie(u.toString());
            if (cookies != null && !cookies.isEmpty()) c.setRequestProperty("Cookie", cookies);
            if (login != null) {
                String up = login[0] + ":" + login[1];
                c.setRequestProperty("Authorization", "Basic " + android.util.Base64.encodeToString(up.getBytes("UTF-8"), android.util.Base64.NO_WRAP));
            }
            if (!f.optString("etag").isEmpty()) c.setRequestProperty("If-None-Match", f.optString("etag"));
            if (!f.optString("lm").isEmpty()) c.setRequestProperty("If-Modified-Since", f.optString("lm"));
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && code != 304) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new Exception("preusmjeravanje bez adrese");
                URL next = new URL(u, loc);
                if (!host.equalsIgnoreCase(next.getHost())) throw new NeedLogin("page", next.getHost());
                u = next;
                continue;
            }
            break;
        }
        if (c == null) throw new Exception("previše preusmjeravanja");
        int code = c.getResponseCode();
        if (code == 304) {
            r.put("status", "same");
            r.put("sha", f.optString("sha"));
            r.put("etag", f.optString("etag"));
            r.put("lm", f.optString("lm"));
            c.disconnect();
            return;
        }
        if (code == 401) {
            String how = c.getHeaderField("WWW-Authenticate");
            c.disconnect();
            throw new NeedLogin("auth", (how == null ? "" : how) + (login != null ? " (odbijeno)" : ""));
        }
        if (code != 200) {
            c.disconnect();
            throw new Exception("server je odgovorio " + code);
        }
        String file = UUID.randomUUID().toString().replace("-", "") + ".pdf";
        File dst = new File(inbox, file);
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long size = 0;
        byte[] head = new byte[5];
        InputStream in = c.getInputStream();
        try {
            FileOutputStream o = new FileOutputStream(dst);
            try {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (size < 5) System.arraycopy(buf, 0, head, (int) size, (int) Math.min(5 - size, n));
                    size += n;
                    if (size > MAX) throw new Exception("fajl je prevelik");
                    md.update(buf, 0, n);
                    o.write(buf, 0, n);
                }
            } finally {
                o.close();
            }
        } catch (Exception e) {
            dst.delete();
            throw e;
        } finally {
            in.close();
            c.disconnect();
        }
        if (!new String(head, "ISO-8859-1").startsWith("%PDF")) {
            dst.delete();
            String ct = c.getContentType();
            if (ct != null && ct.contains("html")) throw new NeedLogin("page", u.getHost()); // a sign-in page of the server itself
            throw new Exception("server nije poslao PDF");
        }
        StringBuilder sha = new StringBuilder();
        for (byte b : md.digest()) sha.append(String.format("%02x", b));
        r.put("sha", sha.toString());
        r.put("etag", c.getHeaderField("ETag") == null ? "" : c.getHeaderField("ETag"));
        r.put("lm", c.getHeaderField("Last-Modified") == null ? "" : c.getHeaderField("Last-Modified"));
        r.put("size", size);
        if (sha.toString().equals(f.optString("sha"))) {
            dst.delete();
            r.put("status", "same");
            return;
        }
        r.put("status", "new");
        r.put("file", file);
    }
}
