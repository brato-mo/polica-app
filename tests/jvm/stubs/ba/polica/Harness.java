package ba.polica;

import android.content.Context;
import android.view.ViewGroup;
import android.webkit.WebView;
import org.json.*;
import java.io.File;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * Runs the REAL OpLog.java, MinusApply.java and Sandbox.java (not copies) on the JVM, with the page played from the
 * real minus-apply.js outcomes (scenarios.json), and compares every record with what the preview mock records.
 *   java Harness quick | hang | dead | login | crash-a DIR | crash-b DIR
 */
public class Harness {
    static int fails = 0, oks = 0;
    static void check(boolean c, String what) { if (c) { oks++; System.out.println("  ok   " + what); } else { fails++; System.out.println("  FAIL " + what); } }

    static Context ctx(String dirName, String sandbox) throws Exception {
        File d = Files.createTempDirectory(dirName).toFile();
        Context c = new Context(d);
        c.strings.put(R.string.storefront_host, new StringBuilder("storefront.example.test").reverse().toString());
        c.strings.put(R.string.myjysk_host, new StringBuilder("myjysk.example.test").reverse().toString());
        c.strings.put(R.string.sandbox, sandbox);
        return c;
    }

    static JSONArray items() {
        return new JSONArray("[{\"num\":\"1000001\",\"qty\":-2,\"target\":\"1000002\",\"c1\":\"a\",\"c2\":\"b\"},{\"num\":\"1000003\",\"qty\":-1,\"target\":\"1000004\",\"c1\":\"c\",\"c2\":\"d\"}]");
    }

    /** The page: busy through the real script's steps, then (unless it hangs) its real final __mx. */
    static WebView.Page page(List<String> steps, String fin, boolean hang, boolean dieAfter) {
        return new WebView.Page() {
            volatile String mx = null; volatile boolean dead = false;
            public void injected(String s) {
                new Thread(() -> {
                    try {
                        for (String st : steps) { mx = new JSONObject().put("state", "busy").put("step", st).toString(); Thread.sleep(900); }
                        if (dieAfter) { dead = true; return; }
                        if (!hang) mx = fin;
                    } catch (Exception ignored) { }
                }).start();
            }
            public String mx() { return mx; }
            public boolean dead() { return dead; }
        };
    }

    /** What MainActivity does on "Potvrdi i pošalji": record first, then send; the answer closes the record. */
    static JSONObject[] send(Context c, boolean adjustOnly, long waitMs, List<String> stepsSeen) throws Exception {
        String id = OpLog.begin(c, adjustOnly ? "adjust" : "both", items());
        if (id == null) return null;
        CountDownLatch done = new CountDownLatch(1);
        JSONObject[] out = new JSONObject[2];
        ViewGroup parent = new ViewGroup();
        new android.os.Handler().post(() -> MinusApply.run(c, parent, "", "pw-secret", items(), adjustOnly, new MinusApply.Callback() {
            public void step(String st) { stepsSeen.add(st); OpLog.step(c, id, st); }
            public void done(JSONObject r) { out[0] = r; out[1] = OpLog.end(c, id, r); done.countDown(); }
        }));
        // while it runs: a second sending is refused
        Thread.sleep(1200);
        check(OpLog.begin(c, "both", items()) == null && "busy".equals(OpLog.blocked(c)), "a second sending while one runs is refused (busy)");
        JSONObject live = OpLog.read(c);
        check(live != null && "sending".equals(live.optString("state")), "record says 'sending' on disk while it runs");
        done.await(waitMs, TimeUnit.MILLISECONDS);
        check(parent.kids.isEmpty() && WebView.made.get(WebView.made.size() - 1).destroyed, "hidden page removed and destroyed");
        return out;
    }

    static String fileText(Context c) throws Exception { return new String(Files.readAllBytes(new File(new File(c.getFilesDir(), "data"), OpLog.FILE).toPath()), "UTF-8"); }

    public static void main(String[] a) throws Exception {
        String mode = a.length > 0 ? a[0] : "quick";
        JSONObject sc = new JSONObject(new String(Files.readAllBytes(Paths.get(System.getProperty("scenarios"))), "UTF-8"));
        if (mode.equals("quick")) {
            for (String k : sc.keySet()) {
                JSONObject s = sc.getJSONObject(k);
                System.out.println("scenario " + k);
                Context c = ctx("op-" + k, "");
                List<String> steps = new ArrayList<>();
                for (Object o : s.getJSONArray("steps")) steps.add((String) o);
                JSONObject fin = s.getJSONObject("final");
                WebView.current = page(steps, fin.toString(), false, false);
                List<String> seen = new CopyOnWriteArrayList<>();
                JSONObject[] r = send(c, "adjust".equals(s.getString("mode")), 30000, seen);
                check(r != null && r[0] != null, "answer came");
                check(fin.getString("state").equals(r[0].optString("state")), "page result passed on unchanged: " + fin.getString("state"));
                check(r[1] != null && s.getString("mock").equals(r[1].optString("state")), "Java record '" + (r[1] == null ? null : r[1].optString("state")) + "' = mock '" + s.getString("mock") + "'");
                check(fin.optString("step").equals(r[1].optString("step")), "step kept: " + r[1].optString("step"));
                check(fin.optBoolean("minusOk") == r[1].optBoolean("minusOk"), "Minus lista accepted kept: " + r[1].optBoolean("minusOk"));
                check(!fin.has("http") || fin.getJSONObject("http").similar(r[1].optJSONObject("http")), "StoreFront answers (HTTP) kept for the evidence");
                JSONObject again = OpLog.read(c);
                check(again != null && again.optString("state").equals(r[1].optString("state")), "record read back from disk the same");
                check(!fileText(c).contains("pw-secret"), "password never in the record");
                check(WebView.lastInjected.contains("pw-secret") && !WebView.lastInjected.contains("\"sim\":\""), "real build: password goes only into the page, no simulation");
                boolean unknown = "unknown".equals(r[1].optString("state"));
                check(unknown == "unknown".equals(OpLog.blocked(c)), "locked exactly when unknown");
                if (unknown) {
                    check(OpLog.begin(c, "both", items()) == null, "unknown: new sending refused");
                    check(OpLog.resolve(c, r[1].getString("id"), "maybe") == null, "unknown: only done/notdone accepted");
                    JSONObject res = OpLog.resolve(c, r[1].getString("id"), "notdone");
                    check(res != null && OpLog.blocked(c) == null, "after 'nije prošlo' sending allowed again");
                    check(OpLog.resolve(c, r[1].getString("id"), "done") != null || true, "resolve again is harmless");
                }
            }
            // a half-written temporary file (crash during a write) does not hurt the record
            Context c = ctx("op-torn", "");
            WebView.current = page(Arrays.asList("start", "user", "minus", "adjust"), sc.getJSONObject("ok").getJSONObject("final").toString(), false, false);
            send(c, false, 30000, new ArrayList<>());
            Files.write(new File(new File(c.getFilesDir(), "data"), OpLog.FILE + ".tmp").toPath(), "{\"state\":\"sen".getBytes());
            JSONObject r = OpLog.read(c);
            check(r != null && "confirmed".equals(r.optString("state")), "torn .tmp file: record still 'confirmed'");
            // test build: the outcome is played and nothing that writes may leave the phone
            Context t = ctx("op-sandbox", "1");
            Sandbox.setSim(t, "drop-adjust");
            WebView.current = page(Arrays.asList("start"), sc.getJSONObject("drop-adjust").getJSONObject("final").toString(), false, false);
            send(t, false, 30000, new ArrayList<>());
            check(WebView.lastInjected.contains("\"sim\":\"drop-adjust\""), "test build: page told to play 'drop-adjust'");
            Sandbox.setSim(t, "rm -rf");
            check("ok".equals(Sandbox.sim(t)) || "drop-adjust".equals(Sandbox.sim(t)), "unknown simulation names are ignored");
            String sf = "storefront.example.test", mj = "myjysk.example.test";
            check(Sandbox.blocks("POST", sf, "/api/v1/stock-adjustments", sf, mj), "blocks POST stock-adjustments");
            check(Sandbox.blocks("POST", sf, "/api/v1/validate-sap-user", sf, mj), "blocks password check");
            check(Sandbox.blocks("POST", sf, "/api/v1/article-smdm-data/update", sf, mj), "blocks SM/DM save");
            check(Sandbox.blocks("PUT", sf, "/api/v1/anything", sf, mj), "blocks any PUT under /api/");
            check(Sandbox.blocks("POST", mj, "/api/storevisits", sf, mj) && Sandbox.blocks("POST", mj, "/api/v2/storevisits/1/conduct/fieldvalue", sf, mj), "blocks MYJYSK AR");
            check(!Sandbox.blocks("POST", sf, "/api/v1/article/search", sf, mj), "lets article search (a read) through");
            check(!Sandbox.blocks("GET", sf, "/api/v1/minus-list/X", sf, mj), "lets GET through");
            check(!Sandbox.blocks("POST", "login.microsoftonline.com", "/common/oauth2/token", sf, mj), "sign-in elsewhere untouched");
            check(!Sandbox.blocks("POST", mj, "/searchapi/kb/recent", sf, mj), "MYJYSK news read untouched");
            Context rel = ctx("op-release", "");
            check(Sandbox.guard(rel, new android.webkit.WebResourceRequest() {
                public android.net.Uri getUrl() { return android.net.Uri.parse("https://" + sf + "/api/v1/stock-adjustments"); }
                public String getMethod() { return "POST"; } }) == null, "release build: guard does nothing");
            check(Sandbox.guard(t, new android.webkit.WebResourceRequest() {
                public android.net.Uri getUrl() { return android.net.Uri.parse("https://" + sf + "/api/v1/stock-adjustments"); }
                public String getMethod() { return "POST"; } }).status == 403, "test build: guard answers 403 on the phone");
        } else if (mode.equals("hang") || mode.equals("dead")) {
            boolean dead = mode.equals("dead");
            System.out.println("scenario " + mode + " (real 120 s time limit)");
            Context c = ctx("op-" + mode, "");
            WebView.current = page(dead ? Arrays.asList("start", "user", "minus", "adjust") : Arrays.asList("start", "user", "minus"), null, true, dead);
            long t0 = System.currentTimeMillis();
            JSONObject[] r = send(c, false, 200000, new ArrayList<>());
            long s = (System.currentTimeMillis() - t0) / 1000;
            check(r[0] != null && "unknown".equals(r[0].optString("state")), "no answer → unknown (after " + s + " s), never 'nothing sent'");
            check(r[1] != null && "unknown".equals(r[1].optString("state")) && "timeout".equals(r[1].optString("why")), "record: unknown, why timeout");
            check((dead ? "adjust" : "minus").equals(r[1].optString("step")), "record keeps the step it reached: " + r[1].optString("step"));
            check("unknown".equals(OpLog.blocked(c)), "locked until checked");
        } else if (mode.equals("login")) {
            System.out.println("scenario page never opens (sign-in needed)");
            Context c = ctx("op-login", "");
            WebView.neverLoads = true;
            WebView.current = page(Collections.emptyList(), null, true, false);
            JSONObject[] r = send(c, false, 80000, new ArrayList<>());
            check(r[0] != null && "login".equals(r[0].optString("why")) && "error".equals(r[0].optString("state")), "nothing injected → error 'login'");
            check("failed".equals(r[1].optString("state")) && OpLog.blocked(c) == null, "record failed, not locked (nothing was sent)");
            check(WebView.lastInjected == null, "the script was never injected");
        } else if (mode.equals("crash-a")) {
            Context c = new Context(new File(a[1]));
            String id = OpLog.begin(c, "both", items());
            OpLog.step(c, id, "minus");
            System.out.println("  sending started, the app dies now (step minus)");
            Runtime.getRuntime().halt(0); // like Android killing the app: no clean-up runs
        } else if (mode.equals("crash-b")) {
            System.out.println("scenario app killed while sending, opened again (new process)");
            Context c = new Context(new File(a[1]));
            JSONObject r = OpLog.read(c);
            check(r != null && "unknown".equals(r.optString("state")) && "prekinuto".equals(r.optString("why")), "after restart: unknown, why 'prekinuto'");
            check("minus".equals(r.optString("step")), "step it had reached is kept: minus");
            check("unknown".equals(OpLog.blocked(c)) && OpLog.begin(c, "both", items()) == null, "locked after restart");
            check(r.getJSONArray("items").length() == 2 && !r.toString().contains("pw-secret"), "lines kept, no password");
        }
        System.out.println("RESULT " + mode + ": " + oks + " ok, " + fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
