package ba.polica;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * The record of the last Minus lista / Regulacija zalihe sending, in data/minus-op.json. It is written (and synced to
 * the disk) BEFORE anything is sent and again when the answer comes, so it survives the app being closed, the phone
 * restarting and the internet dropping. States:
 *   sending    the sending runs now; found like this with no sending running = the app died meanwhile: unknown
 *   confirmed  StoreFront accepted every step
 *   partial    Minus lista accepted, Regulacija zalihe refused (the Regulacija lines can be sent on their own)
 *   failed     refused before anything was written, nothing changed
 *   unknown    "Ishod nepoznat – potrebna provjera": a step was sent but its answer never came (or was a server
 *              error). Nothing more is sent until the employee checked and said what he found (resolve).
 * Only one sending at a time, in the whole app: begin() refuses while one runs or an unknown one is unresolved.
 */
final class OpLog {
    static final String FILE = "minus-op.json";
    private static volatile boolean live;

    private OpLog() {
    }

    private static File file(Context ctx) {
        File d = new File(ctx.getFilesDir(), "data");
        if (!d.isDirectory()) d.mkdirs();
        return new File(d, FILE);
    }

    static synchronized JSONObject read(Context ctx) {
        File f = file(ctx);
        if (!f.isFile()) return null;
        try {
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            } finally {
                in.close();
            }
            JSONObject o = new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
            // a sending that is not running any more never answered: its outcome is not known
            if ("sending".equals(o.optString("state")) && !live) {
                o.put("state", "unknown");
                o.put("why", "prekinuto");
                o.put("end", System.currentTimeMillis());
                write(ctx, o);
            }
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean write(Context ctx, JSONObject o) {
        return MainActivity.writeAtomic(file(ctx), o.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** Why a new sending may not start now, or null when it may. */
    static synchronized String blocked(Context ctx) {
        if (live) return "busy";
        JSONObject o = read(ctx);
        if (o != null && "unknown".equals(o.optString("state")) && o.optJSONObject("resolved") == null) return "unknown";
        return null;
    }

    /** Before anything is sent. Answer: the record's id, or null when the sending must not start. */
    static synchronized String begin(Context ctx, String kind, JSONArray items) {
        if (blocked(ctx) != null) return null;
        try {
            JSONObject o = new JSONObject();
            String id = UUID.randomUUID().toString();
            o.put("id", id);
            o.put("kind", kind);
            o.put("state", "sending");
            o.put("step", "start");
            o.put("at", System.currentTimeMillis());
            JSONArray clean = new JSONArray();
            for (int i = 0; i < items.length(); i++) {
                JSONObject x = items.optJSONObject(i);
                if (x == null) continue;
                JSONObject y = new JSONObject();
                y.put("num", x.optString("num"));
                y.put("qty", x.opt("qty"));
                y.put("target", x.optString("target"));
                y.put("c1", x.optString("c1"));
                y.put("c2", x.optString("c2"));
                clean.put(y);
            }
            o.put("items", clean);
            if (!write(ctx, o)) return null; // not recorded = not sent
            live = true;
            return id;
        } catch (Exception e) {
            return null;
        }
    }

    /** The step the sending reached (from the page), kept so an interruption says where it stopped. */
    static synchronized void step(Context ctx, String id, String step) {
        try {
            JSONObject o = rawRead(ctx);
            if (o == null || !id.equals(o.optString("id")) || step.equals(o.optString("step"))) return;
            o.put("step", step);
            write(ctx, o);
        } catch (Exception ignored) {
        }
    }

    /** The answer of the sending: result as minus-apply.js left it (state ok | error | unknown). Returns the record. */
    static synchronized JSONObject end(Context ctx, String id, JSONObject result) {
        live = false;
        try {
            JSONObject o = rawRead(ctx);
            if (o == null || !id.equals(o.optString("id"))) return null;
            String st = result.optString("state");
            String step = result.optString("step", o.optString("step"));
            boolean adjustOnly = "adjust".equals(o.optString("kind"));
            String state;
            if ("ok".equals(st)) state = "confirmed";
            else if ("unknown".equals(st)) state = "unknown";
            else if (!adjustOnly && "adjust".equals(step)) state = "partial";
            else state = "failed";
            o.put("state", state);
            o.put("step", step);
            o.put("why", result.optString("why"));
            o.put("end", System.currentTimeMillis());
            if (result.has("sent")) o.put("sent", result.opt("sent"));
            if (result.has("skipped")) o.put("skipped", result.opt("skipped"));
            if (result.has("http")) o.put("http", result.opt("http"));
            if (result.has("minusOk")) o.put("minusOk", result.optBoolean("minusOk"));
            if (result.has("resp")) o.put("resp", result.opt("resp"));
            write(ctx, o);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** The employee checked an unknown sending in StoreFront: how = "done" (it went through) or "notdone". */
    static synchronized JSONObject resolve(Context ctx, String id, String how) {
        if (!"done".equals(how) && !"notdone".equals(how)) return null;
        try {
            JSONObject o = read(ctx);
            if (o == null || !id.equals(o.optString("id")) || !"unknown".equals(o.optString("state"))) return null;
            JSONObject r = new JSONObject();
            r.put("how", how);
            r.put("at", System.currentTimeMillis());
            o.put("resolved", r);
            write(ctx, o);
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    private static JSONObject rawRead(Context ctx) {
        File f = file(ctx);
        if (!f.isFile()) return null;
        try {
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            } finally {
                in.close();
            }
            return new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }
}
