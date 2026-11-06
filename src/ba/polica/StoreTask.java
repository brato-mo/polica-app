package ba.polica;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Runs jobs of assets/store-task.js in hidden WebViews on StoreFront with the employee's own sign-in: finding an
 * article (all status codes), an article's stock and its history, the department's best sellers, its SM/DM values,
 * or saving the SM values he chose. Answer: ok + result, login (StoreFront wants a sign-in), error. A job that
 * writes is injected exactly once, never again on a reload, so nothing is sent twice.
 *
 * Since 1.59: at most LANES jobs at a time (the rest wait in order), and a page that has finished a reading job stays
 * open for IDLE_MS, so the next reading starts at once instead of opening StoreFront again. These hidden pages do
 * not load StoreFront's own screens (its scripts, styles, fonts, pictures, telemetry): the jobs only need the
 * signed-in address. A job that writes always gets a page of its own, closed right after.
 */
final class StoreTask {
    interface Callback {
        void done(JSONObject answer);
    }

    private static final long TIMEOUT_MS = 120000; // the best sellers of a whole department take StoreFront ~40 s
    private static final long AWAY_MS = 12000; // this long on a sign-in page: the employee has to sign in

    private StoreTask() {
    }

    static final int LANES = 2;
    static long IDLE_MS = 60000;
    private static final long POLL_MS = 300; // how often a running job is looked at (a few microseconds each) // not final: the tests shorten it

    /** A job waiting or running. */
    private static final class Job {
        Context ctx;
        ViewGroup parent;
        JSONObject arg;
        Callback cb;
    }

    /** A hidden StoreFront page; kept open between reading jobs. */
    private static final class Lane {
        WebView w;
        boolean warm; // a job has run here and the page was on StoreFront when it ended
        boolean busy;
        boolean single; // a writing job: closed after it
        Runnable idle;
    }

    private static final java.util.ArrayDeque<Job> QUEUE = new java.util.ArrayDeque<>();
    private static final java.util.ArrayList<Lane> OPEN = new java.util.ArrayList<>();
    private static Handler ui;

    static void run(Context ctx, ViewGroup parent, String argJson, Callback cb) {
        try {
            Job j = new Job();
            j.ctx = ctx;
            j.parent = parent;
            j.arg = new JSONObject(argJson);
            j.cb = cb;
            if (ui == null) ui = new Handler(Looper.getMainLooper());
            QUEUE.add(j);
            pump();
        } catch (Throwable e) {
            cb.done(answer("error", null));
        }
    }

    /** For the tests: how many hidden pages are open, how many jobs wait. */
    static int openPages() {
        return OPEN.size();
    }

    static int waiting() {
        return QUEUE.size();
    }

    /** Starts what can start: a free warm page first, else a new page while fewer than LANES run. */
    private static void pump() {
        while (!QUEUE.isEmpty()) {
            int busy = 0;
            Lane free = null;
            for (Lane l : OPEN) {
                if (l.busy) busy++;
                else if (free == null && !l.single) free = l;
            }
            if (busy >= LANES) return;
            Job j = QUEUE.peek();
            boolean sends = "smset".equals(j.arg.optString("mode"));
            Lane lane;
            if (!sends && free != null) {
                lane = free;
                if (lane.idle != null) ui.removeCallbacks(lane.idle);
            } else {
                if (OPEN.size() >= LANES && free != null) close(free); // make room: an idle page goes
                if (OPEN.size() >= LANES + 1) return; // (a writing page never pushes out a running one)
                lane = new Lane();
                lane.single = sends;
                OPEN.add(lane);
            }
            QUEUE.poll();
            lane.busy = true;
            try {
                run0(j.ctx, j.parent, j.arg, j.cb, lane);
            } catch (Throwable e) {
                lane.busy = false;
                close(lane);
                j.cb.done(answer("error", null));
            }
        }
    }

    private static void close(Lane l) {
        OPEN.remove(l);
        if (l.idle != null && ui != null) ui.removeCallbacks(l.idle);
        try {
            if (l.w != null) {
                if (l.w.getParent() != null) ((ViewGroup) l.w.getParent()).removeView(l.w);
                l.w.destroy();
            }
        } catch (Exception ignored) {
        }
        l.w = null;
        CookieManager.getInstance().flush();
    }

    /** A job ended on this page: keep it for the next reading (warm), or close it. */
    private static void release(final Lane l, boolean keep) {
        l.busy = false;
        if (!keep || l.single) {
            close(l);
        } else {
            l.warm = true;
            l.idle = new Runnable() {
                @Override
                public void run() {
                    if (!l.busy) close(l);
                }
            };
            ui.postDelayed(l.idle, IDLE_MS);
        }
        pump();
    }

    /** Hidden job pages load only what the jobs need: not StoreFront's own screens (null = load normally). */
    static android.webkit.WebResourceResponse lean(String sfHost, android.webkit.WebResourceRequest r) {
        Uri u = r.getUrl();
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase(java.util.Locale.ROOT);
        String p = u.getPath() == null ? "" : u.getPath();
        boolean sf = h.equalsIgnoreCase(sfHost);
        boolean signIn = h.startsWith("idp.") || h.startsWith("login.") || h.startsWith("sts.") || h.startsWith("adfs.") || h.endsWith("microsoftonline.com");
        String type = null;
        if (sf && p.startsWith("/ui/assets/")) type = p.endsWith(".css") ? "text/css" : p.endsWith(".js") ? "text/javascript" : "application/octet-stream";
        else if (!sf && !signIn) type = "text/plain"; // telemetry and other outside addresses
        if (type == null) return null;
        return new android.webkit.WebResourceResponse(type, "utf-8", 200, "OK", new java.util.HashMap<String, String>(),
            new java.io.ByteArrayInputStream(new byte[0]));
    }

    private static JSONObject answer(String how, JSONObject from) {
        JSONObject o = new JSONObject();
        try {
            o.put("how", how);
            if (from != null) {
                if (from.has("res")) o.put("res", from.get("res"));
                o.put("prog", from.optString("prog"));
                o.put("job", from.optString("job"));
                o.put("err", from.optString("err"));
                o.put("step", from.optString("step"));
                o.put("id", from.optLong("id"));
                o.put("done", from.optInt("done"));
            }
        } catch (Exception ignored) {
        }
        return o;
    }

    private static void run0(Context ctx, final ViewGroup parent, JSONObject arg, final Callback cb, final Lane lane) {
        if (Sandbox.on(ctx)) {
            try {
                arg.put("dry", true); // test build: the script plays a sending instead of making it
            } catch (Exception ignored) {
            }
        }
        final String host = new StringBuilder(ctx.getString(R.string.storefront_host)).reverse().toString().trim();
        final boolean sends = "smset".equals(arg.optString("mode"));
        final String job = arg.optString("job");
        final String mode = arg.optString("mode").replaceAll("[^a-z]", "");
        final String script = "window.__st=null;window.__stArg=" + JSONObject.quote(arg.toString()) + ";window.__stArg=JSON.parse(window.__stArg);" + asset(ctx, "store-task.js");
        final boolean reuse = lane.w != null && lane.warm;
        if (lane.w == null) {
            final WebView nw = new WebView(ctx.getApplicationContext());
            WebSettings st = nw.getSettings();
            st.setJavaScriptEnabled(true);
            st.setDomStorageEnabled(true);
            st.setAllowFileAccess(false);
            st.setAllowContentAccess(false);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(nw, true);
            nw.setAlpha(0f);
            nw.setWebViewClient(new WebViewClient() {
                @Override
                public android.webkit.WebResourceResponse shouldInterceptRequest(WebView sbView, android.webkit.WebResourceRequest sbReq) {
                    android.webkit.WebResourceResponse g = Sandbox.guard(sbView.getContext(), sbReq); // test builds: nothing that writes leaves the phone
                    return g != null ? g : lean(host, sbReq);
                }

                @Override
                public void onPageStarted(WebView sbView, String sbUrl, android.graphics.Bitmap sbIcon) {
                    super.onPageStarted(sbView, sbUrl, sbIcon);
                    Sandbox.page(sbView.getContext(), sbView); // test builds only
                }

                @Override
                public void onPageFinished(WebView v, String url) {
                    AutoLogin.onPage(v.getContext(), v, url); // the session ran out: sign in again with the kept login
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    return !"https".equals(r.getUrl().getScheme());
                }
            });
            if (parent != null) parent.addView(nw, new ViewGroup.LayoutParams(1, 1));
            nw.loadUrl("https://" + host + "/ui/");
            lane.w = nw;
        }
        final WebView w = lane.w;
        final long t0 = System.currentTimeMillis();
        final long[] awaySince = {0};
        final long[] readySince = {0};
        final boolean[] over = {false};
        final boolean[] injected = {false};
        final int[] nulls = {0};
        final Runnable[] tick = new Runnable[1];
        tick[0] = new Runnable() {
            @Override
            public void run() {
                if (over[0]) return;
                long now = System.currentTimeMillis();
                if (now - t0 > TIMEOUT_MS) {
                    JSONObject x = new JSONObject();
                    try {
                        x.put("err", "timeout");
                    } catch (Exception ignored) {
                    }
                    finish("error", x);
                    return;
                }
                String url = w.getUrl();
                boolean onMj = url != null && host.equalsIgnoreCase(Uri.parse(url).getHost()) && w.getProgress() >= 100 && Uri.parse(url).getPath() != null && Uri.parse(url).getPath().startsWith("/ui");
                if (!injected[0]) {
                    if (!onMj) {
                        readySince[0] = 0;
                        if (w.getProgress() < 100) awaySince[0] = 0;
                        else if (awaySince[0] == 0) awaySince[0] = now;
                        else if (now - awaySince[0] > AWAY_MS) finish("login", null);
                    } else {
                        awaySince[0] = 0;
                        if (readySince[0] == 0 && !reuse) readySince[0] = now;
                        else if (reuse || now - readySince[0] > 1200) { // the page has settled (no redirect to the sign-in)
                            injected[0] = true;
                            w.evaluateJavascript(script, null);
                        }
                    }
                    ui.postDelayed(tick[0], POLL_MS);
                    return;
                }
                w.evaluateJavascript("JSON.stringify(window.__st||null)", new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        if (over[0]) return;
                        JSONObject o = parse(v);
                        if (o == null) {
                            // the page was replaced after the job started. Reading is simply started again; sending is
                            // not (it may have made the visit already): the employee looks in MYJYSK.
                            if (++nulls[0] > 4) {
                                if (sends) {
                                    JSONObject x = new JSONObject();
                                    try {
                                        x.put("err", "lost");
                                    } catch (Exception ignored) {
                                    }
                                    finish("error", x);
                                    return;
                                }
                                injected[0] = false;
                                readySince[0] = 0;
                                nulls[0] = 0;
                            }
                        } else {
                            nulls[0] = 0;
                            String s = o.optString("state");
                            if ("ok".equals(s) || "login".equals(s) || "error".equals(s)) {
                                finish(s, o);
                                return;
                            }
                        }
                        ui.postDelayed(tick[0], POLL_MS);
                    }
                });
            }

            private void finish(String how, JSONObject from) {
                if (over[0]) return;
                over[0] = true;
                // the page stays for the next reading when it ended normally on StoreFront; a sign-in, a time-out or
                // a lost page closes it
                String u = w.getUrl();
                boolean onSf = u != null && host.equalsIgnoreCase(Uri.parse(u).getHost()) && Uri.parse(u).getPath() != null && Uri.parse(u).getPath().startsWith("/ui");
                boolean keep = onSf && ("ok".equals(how) || ("error".equals(how) && from != null && !"timeout".equals(from.optString("err")) && !"lost".equals(from.optString("err"))));
                JSONObject a = answer(how, from);
                try {
                    if (a.optString("job").isEmpty()) a.put("job", job);
                } catch (Exception ignored) {
                }
                // for measuring on the phone (Postavke → Kopiraj dijagnostiku): which job, how long, on which page
                Diag.i(w.getContext(), "StoreFront " + mode + " " + how + " " + (System.currentTimeMillis() - t0) + " ms" + (reuse ? " (topla stranica)" : " (nova stranica)"));
                cb.done(a);
                release(lane, keep);
            }
        };
        ui.postDelayed(tick[0], reuse ? 50 : 400);
    }

    private static JSONObject parse(String v) {
        if (v == null || "null".equals(v)) return null;
        try {
            Object a = new JSONTokener(v).nextValue();
            if (!(a instanceof String)) return null;
            Object b = new JSONTokener((String) a).nextValue();
            return b instanceof JSONObject ? (JSONObject) b : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String asset(Context c, String name) {
        try {
            InputStream in = c.getAssets().open(name);
            try {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                return new String(b.toByteArray(), StandardCharsets.UTF_8);
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return "";
        }
    }
}
