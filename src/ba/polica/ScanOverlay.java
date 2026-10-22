package ba.polica;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.provider.Settings;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** Dims the camera picture outside the scan window and draws its corners. */
class ScanOverlay extends View {
    private final Paint mask = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint corner = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path cut = new Path();
    private final RectF win = new RectF();
    private final float d;
    private float sweep = 0.5f;
    private boolean hit;
    private ValueAnimator anim;

    ScanOverlay(Context c) {
        super(c);
        d = getResources().getDisplayMetrics().density;
        mask.setColor(0x99000000);
        corner.setStyle(Paint.Style.STROKE);
        corner.setStrokeWidth(4 * d);
        corner.setStrokeCap(Paint.Cap.ROUND);
        corner.setColor(0xFFFFFFFF);
        line.setColor(0xCCFFC233);
        line.setStrokeWidth(2 * d);
    }

    /** The scan window, in view pixels: wide enough for a product barcode, tall enough for a QR code. */
    RectF window() {
        int w = getWidth(), h = getHeight();
        if (w == 0) return new RectF();
        float ww = Math.min(w * 0.84f, 420 * d);
        float wh = ww * 0.62f;
        float cx = w / 2f, cy = h * 0.44f;
        return new RectF(cx - ww / 2, cy - wh / 2, cx + ww / 2, cy + wh / 2);
    }

    void success() {
        hit = true;
        if (anim != null) anim.cancel();
        invalidate();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        float scale = 1f;
        try {
            scale = Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
        } catch (Exception ignored) {
        }
        if (scale == 0f) return; // the user turned animations off
        anim = ValueAnimator.ofFloat(0f, 1f);
        anim.setDuration(1800);
        anim.setRepeatMode(ValueAnimator.REVERSE);
        anim.setRepeatCount(ValueAnimator.INFINITE);
        anim.setInterpolator(new LinearInterpolator());
        anim.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(ValueAnimator a) {
                sweep = (float) a.getAnimatedValue();
                invalidate();
            }
        });
        anim.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (anim != null) anim.cancel();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        win.set(window());
        float r = 18 * d;
        cut.reset();
        cut.setFillType(Path.FillType.EVEN_ODD);
        cut.addRect(0, 0, getWidth(), getHeight(), Path.Direction.CW);
        cut.addRoundRect(win, r, r, Path.Direction.CW);
        c.drawPath(cut, mask);

        corner.setColor(hit ? 0xFFFFC233 : 0xFFFFFFFF);
        float len = 30 * d;
        float l = win.left, t = win.top, rt = win.right, b = win.bottom;
        Path p = new Path();
        p.moveTo(l, t + len); p.lineTo(l, t + r); p.quadTo(l, t, l + r, t); p.lineTo(l + len, t);
        p.moveTo(rt - len, t); p.lineTo(rt - r, t); p.quadTo(rt, t, rt, t + r); p.lineTo(rt, t + len);
        p.moveTo(rt, b - len); p.lineTo(rt, b - r); p.quadTo(rt, b, rt - r, b); p.lineTo(rt - len, b);
        p.moveTo(l + len, b); p.lineTo(l + r, b); p.quadTo(l, b, l, b - r); p.lineTo(l, b - len);
        c.drawPath(p, corner);

        if (hit) {
            Paint f = new Paint(Paint.ANTI_ALIAS_FLAG);
            f.setColor(0x33FFC233);
            c.drawRoundRect(win, r, r, f);
        } else {
            float y = win.top + win.height() * (0.15f + 0.7f * sweep);
            c.drawLine(win.left + 16 * d, y, win.right - 16 * d, y, line);
        }
    }
}
