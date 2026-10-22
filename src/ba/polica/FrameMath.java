package ba.polica;

/**
 * Pure arithmetic for the scanner, kept free of Android classes so it can be tested on a desktop JVM.
 * Frames arrive in sensor orientation; the user sees them rotated clockwise by the sensor orientation.
 */
final class FrameMath {
    private FrameMath() {
    }

    /**
     * The rectangle of the sensor frame (x0, y0, x1, y1) under the scan window, grown by a margin.
     * vw, vh: view size; win: window {left, top, right, bottom} in view pixels; fw, fh: frame size;
     * rot: sensor orientation (0, 90, 180, 270). The preview fills the view (centre crop).
     */
    static int[] sensorCrop(int vw, int vh, float[] win, int fw, int fh, int rot) {
        if (vw <= 0 || vh <= 0 || win[2] <= win[0]) return new int[] {0, 0, fw, fh};
        boolean swap = rot == 90 || rot == 270;
        float uw = swap ? fh : fw, uh = swap ? fw : fh;
        float scale = Math.max(vw / uw, vh / uh);
        float ox = (uw * scale - vw) / 2f, oy = (uh * scale - vh) / 2f;
        float mx = (win[2] - win[0]) * 0.18f, my = (win[3] - win[1]) * 0.35f;
        float[] xs = {win[0] - mx, win[2] + mx};
        float[] ys = {win[1] - my, win[3] + my};
        int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE;
        for (float px : xs) {
            for (float py : ys) {
                float qx = (px + ox) / scale, qy = (py + oy) / scale; // upright frame
                float sx, sy; // sensor frame
                switch (rot) {
                    case 90: sx = qy; sy = fh - 1 - qx; break;
                    case 270: sx = fw - 1 - qy; sy = qx; break;
                    case 180: sx = fw - 1 - qx; sy = fh - 1 - qy; break;
                    default: sx = qx; sy = qy;
                }
                x0 = Math.min(x0, (int) sx);
                y0 = Math.min(y0, (int) sy);
                x1 = Math.max(x1, (int) Math.ceil(sx));
                y1 = Math.max(y1, (int) Math.ceil(sy));
            }
        }
        x0 = Math.max(0, x0);
        y0 = Math.max(0, y0);
        x1 = Math.min(fw, x1);
        y1 = Math.min(fh, y1);
        if (x1 - x0 < 64 || y1 - y0 < 64) return new int[] {0, 0, fw, fh};
        return new int[] {x0, y0, x1, y1};
    }

    /** The crop turned upright as the user sees it. dims receives {width, height}. */
    static byte[] upright(byte[] luma, int fw, int[] c, int rot, int[] dims) {
        int left = c[0], top = c[1], cw = c[2] - c[0], ch = c[3] - c[1];
        byte[] out = new byte[cw * ch];
        switch (rot) {
            case 90:
                for (int y = 0; y < cw; y++) {
                    for (int x = 0; x < ch; x++) out[y * ch + x] = luma[(top + ch - 1 - x) * fw + left + y];
                }
                dims[0] = ch;
                dims[1] = cw;
                break;
            case 270:
                for (int y = 0; y < cw; y++) {
                    for (int x = 0; x < ch; x++) out[y * ch + x] = luma[(top + x) * fw + left + cw - 1 - y];
                }
                dims[0] = ch;
                dims[1] = cw;
                break;
            case 180:
                for (int y = 0; y < ch; y++) {
                    for (int x = 0; x < cw; x++) out[y * cw + x] = luma[(top + ch - 1 - y) * fw + left + cw - 1 - x];
                }
                dims[0] = cw;
                dims[1] = ch;
                break;
            default:
                for (int y = 0; y < ch; y++) System.arraycopy(luma, (top + y) * fw + left, out, y * cw, cw);
                dims[0] = cw;
                dims[1] = ch;
        }
        return out;
    }

}
