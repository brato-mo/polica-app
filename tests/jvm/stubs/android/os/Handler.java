package android.os;
import java.util.concurrent.*;
/** The main thread: one thread runs everything posted, like Android's main looper. */
public class Handler {
    public static final ScheduledExecutorService MAIN = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "main"); t.setDaemon(true); return t; });
    static final java.util.Map<Runnable, java.util.List<ScheduledFuture<?>>> POSTED = new ConcurrentHashMap<>();
    public Handler(Looper l) {}
    public Handler() {}
    public boolean post(Runnable r) { return postDelayed(r, 0); }
    public boolean postDelayed(Runnable r, long ms) {
        ScheduledFuture<?> f = MAIN.schedule(() -> { try { r.run(); } catch (Throwable e) { e.printStackTrace(); } }, ms, TimeUnit.MILLISECONDS);
        POSTED.computeIfAbsent(r, k -> new CopyOnWriteArrayList<>()).add(f); return true;
    }
    public void removeCallbacks(Runnable r) { java.util.List<ScheduledFuture<?>> l = POSTED.remove(r); if (l != null) for (ScheduledFuture<?> f : l) f.cancel(false); }
}
