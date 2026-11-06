package android.view;
public class ViewGroup extends View implements ViewParent {
    public final java.util.List<View> kids = new java.util.concurrent.CopyOnWriteArrayList<>();
    public void addView(View v, LayoutParams p) { v.parent = this; kids.add(v); }
    public void removeView(View v) { kids.remove(v); v.parent = null; }
    public static class LayoutParams { public static final int MATCH_PARENT = -1; public LayoutParams(int w, int h) {} }
}
