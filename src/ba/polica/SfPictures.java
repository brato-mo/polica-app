package ba.polica;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The pictures of articles that are in none of the employee's planograms, as StoreFront shows them: StoreFront names
 * the picture, this fetches it from JYSK's own image server (resources.jysk.com / cdnN.jysk.com, nothing else) and
 * keeps it in files/thumbs/sf-slike/<article>.<jpg|png|webp>. Only the picture's number is in the request; nothing
 * about the store, the employee or customers.
 */
final class SfPictures {
    static final String DIR = "sf-slike";
    private static final Pattern URL_OK = Pattern.compile("https://(resources|cdn\\d?)\\.jysk\\.com/getimage/[a-z0-9.]{1,20}/\\d{1,12}");
    private static final int MAX = 400 * 1024;
    private static final ExecutorService ONE = Executors.newSingleThreadExecutor();

    private SfPictures() {
    }

    static boolean urlOk(String u) {
        return u != null && URL_OK.matcher(u).matches();
    }

    /** list: [{num, url}]; when done the page gets window.onSfPictures([{num, file}]) (file "" = none). */
    static void fetch(final MainActivity a, String list) {
        final JSONArray in;
        try {
            in = new JSONArray(list);
        } catch (Exception e) {
            return;
        }
        ONE.execute(new Runnable() {
            @Override
            public void run() {
                JSONArray out = new JSONArray();
                File d = new File(a.dir("thumbs"), DIR);
                if (!d.isDirectory()) d.mkdirs();
                for (int i = 0; i < in.length() && i < 40; i++) {
                    JSONObject o = in.optJSONObject(i);
                    if (o == null) continue;
                    String num = o.optString("num"), url = o.optString("url");
                    if (!num.matches("\\d{7}")) continue;
                    String file = "";
                    if (urlOk(url)) {
                        try {
                            file = get(d, num, url);
                        } catch (Exception e) {
                            Diag.w(a, "slika iz StoreFronta", e);
                            continue; // not noted as "no picture": tried again another time
                        }
                    }
                    try {
                        out.put(new JSONObject().put("num", num).put("file", file));
                    } catch (Exception ignored) {
                    }
                }
                a.runJs("window.onSfPictures&&onSfPictures(" + out + ")");
            }
        });
    }

    private static String get(File d, String num, String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            if (code == 404) return "";
            if (code != 200) throw new Exception("http " + code);
            String type = String.valueOf(c.getContentType()).toLowerCase(java.util.Locale.ROOT);
            String ext = type.startsWith("image/jpeg") ? "jpg" : type.startsWith("image/png") ? "png" : type.startsWith("image/webp") ? "webp" : null;
            if (ext == null) return "";
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            InputStream s = c.getInputStream();
            try {
                byte[] b = new byte[16384];
                int n;
                while ((n = s.read(b)) > 0) {
                    buf.write(b, 0, n);
                    if (buf.size() > MAX) return "";
                }
            } finally {
                s.close();
            }
            if (buf.size() < 100) return "";
            String name = num + "." + ext;
            for (String e : new String[]{"jpg", "png", "webp"}) if (!e.equals(ext)) new File(d, num + "." + e).delete();
            return MainActivity.writeAtomic(new File(d, name), buf.toByteArray()) ? name : "";
        } finally {
            c.disconnect();
        }
    }
}
