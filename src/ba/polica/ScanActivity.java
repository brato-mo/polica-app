package ba.polica;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.Result;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;

/**
 * Full-screen barcode scanner: Camera2 preview, frames decoded with ZXing on a
 * background thread. Works offline and without Google services.
 * Returns RESULT_OK with "code" and "format", RESULT_MANUAL to type the number instead,
 * or RESULT_CANCELED.
 */
public class ScanActivity extends Activity implements TextureView.SurfaceTextureListener {
    private static final String TAG = "PolicaScan";
    public static final int RESULT_MANUAL = RESULT_FIRST_USER;
    private static final int REQ_CAMERA = 7;
    private static final int MAX_W = 1920, MAX_H = 1080;

    private TextureView preview;
    private ScanOverlay overlay;
    private TextView hint;
    private IconButton torchButton;
    private View permissionPanel;

    private HandlerThread camThread, decodeThread;
    private Handler camHandler, decodeHandler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private CaptureRequest.Builder request;
    private ImageReader reader;
    private Size previewSize, frameSize;
    private int sensorOrientation = 90;
    private boolean hasFlash, torchOn, opening;
    private Rect sensorArea;

    private volatile boolean busy, done;
    private byte[] luma;
    private int lumaW, lumaH;
    private int frameNo;
    private final MultiFormatReader zx = new MultiFormatReader();

    private float dp(float v) {
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(
                BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
                BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF,
                BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        zx.setHints(hints);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1));
        overlay = new ScanOverlay(this);
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));
        overlay.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent e) {
                if (e.getAction() == MotionEvent.ACTION_UP) focusOnce();
                return true;
            }
        });

        hint = new TextView(this);
        hint.setText("Usmjeri kameru na barkod");
        hint.setTextColor(0xFFFFFFFF);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        hint.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        hint.setGravity(Gravity.CENTER);
        hint.setShadowLayer(dp(6), 0, 0, 0x99000000);
        root.addView(hint, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        IconButton close = new IconButton(this, IconButton.CLOSE);
        close.setContentDescription("Zatvori");
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setResult(RESULT_CANCELED);
                finishQuietly();
            }
        });
        FrameLayout.LayoutParams lpClose = new FrameLayout.LayoutParams((int) dp(56), (int) dp(56), Gravity.TOP | Gravity.START);
        lpClose.setMargins((int) dp(12), (int) dp(12), 0, 0);
        root.addView(close, lpClose);

        torchButton = new IconButton(this, IconButton.TORCH);
        torchButton.setContentDescription("Svjetlo");
        torchButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setTorch(!torchOn);
            }
        });
        torchButton.setVisibility(View.GONE);
        FrameLayout.LayoutParams lpTorch = new FrameLayout.LayoutParams((int) dp(56), (int) dp(56), Gravity.TOP | Gravity.END);
        lpTorch.setMargins(0, (int) dp(12), (int) dp(12), 0);
        root.addView(torchButton, lpTorch);

        TextView manual = pill("Upiši broj artikla");
        manual.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setResult(RESULT_MANUAL);
                finishQuietly();
            }
        });
        FrameLayout.LayoutParams lpManual = new FrameLayout.LayoutParams(-2, (int) dp(52), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lpManual.setMargins(0, 0, 0, (int) dp(40));
        root.addView(manual, lpManual);

        permissionPanel = buildPermissionPanel();
        permissionPanel.setVisibility(View.GONE);
        root.addView(permissionPanel, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        root.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override
            public void onLayoutChange(View v, int l, int t, int r, int b, int ol, int ot, int or, int ob) {
                RectF w = overlay.window();
                if (w.height() > 0) hint.setY(Math.max(dp(80), w.top - dp(56)));
            }
        });
    }

    private TextView pill(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(0xFFFFFFFF);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        t.setGravity(Gravity.CENTER);
        t.setPadding((int) dp(24), 0, (int) dp(24), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x66000000);
        bg.setStroke((int) dp(1), 0x99FFFFFF);
        bg.setCornerRadius(dp(26));
        t.setBackground(bg);
        t.setClickable(true);
        return t;
    }

    private View buildPermissionPanel() {
        LinearLayout p = new LinearLayout(this);
        p.setOrientation(LinearLayout.VERTICAL);
        p.setGravity(Gravity.CENTER);
        p.setBackgroundColor(0xFF0E1014);
        p.setPadding((int) dp(32), 0, (int) dp(32), 0);
        p.setClickable(true);
        TextView title = new TextView(this);
        title.setText("Skeneru treba kamera");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setGravity(Gravity.CENTER);
        p.addView(title);
        TextView body = new TextView(this);
        body.setText("Dozvoli pristup kameri radi čitanja barkodova. Slike se ne spremaju i ne šalju nikome.");
        body.setTextColor(0xCCFFFFFF);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        body.setGravity(Gravity.CENTER);
        body.setLineSpacing(0, 1.2f);
        LinearLayout.LayoutParams lb = new LinearLayout.LayoutParams(-1, -2);
        lb.setMargins(0, (int) dp(12), 0, (int) dp(28));
        p.addView(body, lb);
        TextView allow = pill("Dozvoli kameru");
        ((GradientDrawable) allow.getBackground()).setColor(0xFFFFC233);
        ((GradientDrawable) allow.getBackground()).setStroke(0, 0);
        allow.setTextColor(0xFF141414);
        allow.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
                        || !getSharedPreferences("scan", MODE_PRIVATE).getBoolean("asked", false)) {
                    requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
                } else {
                    try {
                        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception ignored) {
                    }
                }
            }
        });
        p.addView(allow, new LinearLayout.LayoutParams(-2, (int) dp(52)));
        TextView manual = pill("Upiši broj artikla");
        manual.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setResult(RESULT_MANUAL);
                finishQuietly();
            }
        });
        LinearLayout.LayoutParams lm = new LinearLayout.LayoutParams(-2, (int) dp(52));
        lm.setMargins(0, (int) dp(12), 0, 0);
        p.addView(manual, lm);
        return p;
    }

    private void finishQuietly() {
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onResume() {
        super.onResume();
        done = false;
        busy = false;
        startThreads();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            if (!getSharedPreferences("scan", MODE_PRIVATE).getBoolean("asked", false)) {
                requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
            } else {
                permissionPanel.setVisibility(View.VISIBLE);
            }
            return;
        }
        permissionPanel.setVisibility(View.GONE);
        ensureCamera();
    }

    /** Opens the camera once the preview surface exists (now or when it appears). */
    private void ensureCamera() {
        startThreads();
        if (preview.isAvailable()) openCamera();
        else preview.setSurfaceTextureListener(this);
    }

    @Override
    protected void onPause() {
        closeCamera();
        stopThreads();
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req != REQ_CAMERA) return;
        getSharedPreferences("scan", MODE_PRIVATE).edit().putBoolean("asked", true).apply();
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
            permissionPanel.setVisibility(View.GONE);
            ensureCamera();
        } else {
            permissionPanel.setVisibility(View.VISIBLE);
        }
    }

    // ------------------------------------------------------------- threads

    private void startThreads() {
        if (camThread == null) {
            camThread = new HandlerThread("cam");
            camThread.start();
            camHandler = new Handler(camThread.getLooper());
        }
        if (decodeThread == null) {
            decodeThread = new HandlerThread("decode");
            decodeThread.start();
            decodeHandler = new Handler(decodeThread.getLooper());
        }
    }

    private void stopThreads() {
        if (camThread != null) {
            camThread.quitSafely();
            camThread = null;
            camHandler = null;
        }
        if (decodeThread != null) {
            decodeThread.quitSafely();
            decodeThread = null;
            decodeHandler = null;
        }
    }

    // ---------------------------------------------------------------- camera

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED && camHandler != null) openCamera();
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {
        configureTransform();
    }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture st) {
    }

    private static Size pick(Size[] sizes, float aspect) {
        Size best = null;
        for (Size s : sizes) {
            if (s.getWidth() > MAX_W || s.getHeight() > MAX_H) continue;
            float a = (float) s.getWidth() / s.getHeight();
            if (Math.abs(a - aspect) > 0.02f) continue;
            if (best == null || (long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) best = s;
        }
        if (best == null) {
            for (Size s : sizes) {
                if (s.getWidth() > MAX_W || s.getHeight() > MAX_H) continue;
                if (best == null || (long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) best = s;
            }
        }
        return best != null ? best : sizes[0];
    }

    private void openCamera() {
        if (camera != null || opening || camHandler == null) return;
        CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        try {
            String chosen = null;
            CameraCharacteristics cc = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics c = cm.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    chosen = id;
                    cc = c;
                    break;
                }
            }
            if (chosen == null) {
                String[] ids = cm.getCameraIdList();
                if (ids.length == 0) {
                    hint.setText("Kamera nije dostupna");
                    return;
                }
                chosen = ids[0];
                cc = cm.getCameraCharacteristics(chosen);
            }
            StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = so == null ? 90 : so;
            Boolean flash = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            hasFlash = flash != null && flash;
            sensorArea = cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            frameSize = pick(map.getOutputSizes(ImageFormat.YUV_420_888), 16f / 9f);
            previewSize = pick(map.getOutputSizes(SurfaceTexture.class), (float) frameSize.getWidth() / frameSize.getHeight());
            final CameraCharacteristics chars = cc;
            reader = ImageReader.newInstance(frameSize.getWidth(), frameSize.getHeight(), ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader r) {
                    onFrame(r);
                }
            }, camHandler);
            opening = true;
            cm.openCamera(chosen, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice cam) {
                    opening = false;
                    camera = cam;
                    startPreview(chars);
                }

                @Override
                public void onDisconnected(CameraDevice cam) {
                    opening = false;
                    cam.close();
                    camera = null;
                }

                @Override
                public void onError(CameraDevice cam, int error) {
                    opening = false;
                    cam.close();
                    camera = null;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            hint.setText("Kamera se ne može otvoriti");
                        }
                    });
                }
            }, camHandler);
        } catch (CameraAccessException | SecurityException | IllegalArgumentException e) {
            opening = false;
            Log.w(TAG, "open", e);
            hint.setText("Kamera se ne može otvoriti");
        }
    }

    private void startPreview(final CameraCharacteristics cc) {
        try {
            SurfaceTexture st = preview.getSurfaceTexture();
            if (st == null || camera == null) return;
            st.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            final Surface surface = new Surface(st);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    configureTransform();
                    torchButton.setVisibility(hasFlash ? View.VISIBLE : View.GONE);
                }
            });
            request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            request.addTarget(surface);
            request.addTarget(reader.getSurface());
            int[] af = cc.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (contains(af, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
                request.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            } else if (contains(af, CameraMetadata.CONTROL_AF_MODE_AUTO)) {
                request.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
            }
            request.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            int[] scenes = cc.get(CameraCharacteristics.CONTROL_AVAILABLE_SCENE_MODES);
            if (contains(scenes, CameraMetadata.CONTROL_SCENE_MODE_BARCODE)) {
                request.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_USE_SCENE_MODE);
                request.set(CaptureRequest.CONTROL_SCENE_MODE, CameraMetadata.CONTROL_SCENE_MODE_BARCODE);
            }
            // a little zoom lets the phone stay far enough away to focus
            if (Build.VERSION.SDK_INT >= 30) {
                Range<Float> zr = cc.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
                if (zr != null && zr.getUpper() >= 1.5f) request.set(CaptureRequest.CONTROL_ZOOM_RATIO, 1.5f);
            } else if (sensorArea != null) {
                Float maxZoom = cc.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM);
                if (maxZoom != null && maxZoom >= 1.5f) {
                    int cw = (int) (sensorArea.width() / 1.5f), ch = (int) (sensorArea.height() / 1.5f);
                    int x = sensorArea.left + (sensorArea.width() - cw) / 2, y = sensorArea.top + (sensorArea.height() - ch) / 2;
                    request.set(CaptureRequest.SCALER_CROP_REGION, new Rect(x, y, x + cw, y + ch));
                }
            }
            camera.createCaptureSession(Arrays.asList(surface, reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession s) {
                    if (camera == null) return;
                    session = s;
                    repeat();
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession s) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            hint.setText("Kamera se ne može pokrenuti");
                        }
                    });
                }
            }, camHandler);
        } catch (CameraAccessException | IllegalStateException e) {
            Log.w(TAG, "preview", e);
        }
    }

    private static boolean contains(int[] list, int v) {
        if (list == null) return false;
        for (int x : list) if (x == v) return true;
        return false;
    }

    private void repeat() {
        try {
            if (session != null && request != null) session.setRepeatingRequest(request.build(), null, camHandler);
        } catch (CameraAccessException | IllegalStateException e) {
            Log.w(TAG, "repeat", e);
        }
    }

    private void setTorch(boolean on) {
        if (!hasFlash || request == null) return;
        torchOn = on;
        torchButton.setActive(on);
        request.set(CaptureRequest.FLASH_MODE, on ? CameraMetadata.FLASH_MODE_TORCH : CameraMetadata.FLASH_MODE_OFF);
        repeat();
    }

    /** Tap: focus again on the middle of the frame. */
    private void focusOnce() {
        if (session == null || request == null || camHandler == null) return;
        try {
            if (sensorArea != null) {
                int w = sensorArea.width() / 4, h = sensorArea.height() / 4;
                MeteringRectangle r = new MeteringRectangle(sensorArea.centerX() - w / 2, sensorArea.centerY() - h / 2, w, h,
                        MeteringRectangle.METERING_WEIGHT_MAX - 1);
                request.set(CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[] {r});
            }
            request.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
            session.capture(request.build(), null, camHandler);
            request.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_IDLE);
            repeat();
        } catch (CameraAccessException | IllegalStateException e) {
            Log.w(TAG, "focus", e);
        }
    }

    private void closeCamera() {
        try {
            if (session != null) session.close();
        } catch (Exception ignored) {
        }
        session = null;
        if (camera != null) camera.close();
        camera = null;
        if (reader != null) reader.close();
        reader = null;
        torchOn = false;
        opening = false;
    }

    /** Fills the view with the preview (centre crop) instead of stretching it. */
    private void configureTransform() {
        if (previewSize == null) return;
        int vw = preview.getWidth(), vh = preview.getHeight();
        if (vw == 0 || vh == 0) return;
        boolean swap = sensorOrientation == 90 || sensorOrientation == 270;
        float bw = swap ? previewSize.getHeight() : previewSize.getWidth();
        float bh = swap ? previewSize.getWidth() : previewSize.getHeight();
        float scale = Math.max(vw / bw, vh / bh);
        Matrix m = new Matrix();
        m.setScale(bw * scale / vw, bh * scale / vh, vw / 2f, vh / 2f);
        preview.setTransform(m);
    }

    // --------------------------------------------------------------- decoding

    private void onFrame(ImageReader r) {
        Image img;
        try {
            img = r.acquireLatestImage();
        } catch (IllegalStateException e) {
            return;
        }
        if (img == null) return;
        try {
            if (busy || done || decodeHandler == null) return;
            int w = img.getWidth(), h = img.getHeight();
            Image.Plane p = img.getPlanes()[0];
            ByteBuffer b = p.getBuffer();
            int rs = p.getRowStride(), ps = p.getPixelStride();
            if (luma == null || luma.length != w * h) luma = new byte[w * h];
            if (ps == 1) {
                for (int y = 0; y < h; y++) {
                    b.position(y * rs);
                    b.get(luma, y * w, w);
                }
            } else {
                for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) luma[y * w + x] = b.get(y * rs + x * ps);
            }
            lumaW = w;
            lumaH = h;
            busy = true;
            decodeHandler.post(decodeTask);
        } catch (Exception e) {
            Log.w(TAG, "frame", e);
        } finally {
            img.close();
        }
    }

    private final Runnable decodeTask = new Runnable() {
        @Override
        public void run() {
            try {
                Result res = decodeFrame();
                if (res != null) found(res);
            } catch (Throwable t) {
                Log.w(TAG, "decode", t);
            } finally {
                busy = false;
            }
        }
    };

    private Result tryDecode(byte[] data, int w, int h) {
        PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false);
        try {
            return zx.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
        } catch (ReaderException ignored) {
        } finally {
            zx.reset();
        }
        try {
            return zx.decodeWithState(new BinaryBitmap(new GlobalHistogramBinarizer(src)));
        } catch (ReaderException ignored) {
        } finally {
            zx.reset();
        }
        return null;
    }

    private Result decodeFrame() {
        if (luma == null) return null;
        frameNo++;
        RectF w = overlay.window();
        int[] c = FrameMath.sensorCrop(overlay.getWidth(), overlay.getHeight(),
                new float[] {w.left, w.top, w.right, w.bottom}, lumaW, lumaH, sensorOrientation);
        int[] dims = new int[2];
        byte[] up = FrameMath.upright(luma, lumaW, c, sensorOrientation, dims);
        Result r = tryDecode(up, dims[0], dims[1]);
        if (r == null && frameNo % 3 == 0) {
            // barcode turned sideways on screen: read the crop a quarter turn further
            byte[] side = FrameMath.upright(luma, lumaW, c, (sensorOrientation + 90) % 360, dims);
            r = tryDecode(side, dims[0], dims[1]);
        }
        return r;
    }

    private void found(final Result res) {
        if (done) return;
        done = true;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (getIntent().getBooleanExtra("vibrate", true) && v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(35, VibrationEffect.DEFAULT_AMPLITUDE));
                overlay.success();
                hint.setText(res.getText());
                Intent data = new Intent();
                data.putExtra("code", res.getText());
                data.putExtra("format", res.getBarcodeFormat().name());
                setResult(RESULT_OK, data);
                overlay.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        finishQuietly();
                    }
                }, 160);
            }
        });
    }

    // -------------------------------------------------------------- widgets

    /** Round translucent button with a drawn icon (close, torch). */
    static class IconButton extends View {
        static final int CLOSE = 0, TORCH = 1;
        private final int kind;
        private boolean active;
        private final android.graphics.Paint fill = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.Paint stroke = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.Path path = new android.graphics.Path();

        IconButton(Context c, int kind) {
            super(c);
            this.kind = kind;
            setClickable(true);
            setFocusable(true);
            stroke.setStyle(android.graphics.Paint.Style.STROKE);
            stroke.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            stroke.setStrokeJoin(android.graphics.Paint.Join.ROUND);
        }

        void setActive(boolean a) {
            active = a;
            invalidate();
        }

        @Override
        protected void onDraw(android.graphics.Canvas cv) {
            float w = getWidth(), h = getHeight(), r = Math.min(w, h) / 2f;
            float d = getResources().getDisplayMetrics().density;
            fill.setColor(active ? 0xFFFFC233 : 0x66000000);
            cv.drawCircle(w / 2, h / 2, r, fill);
            stroke.setColor(active ? 0xFF141414 : 0xFFFFFFFF);
            stroke.setStrokeWidth(2.2f * d);
            float s = 8 * d;
            if (kind == CLOSE) {
                cv.drawLine(w / 2 - s, h / 2 - s, w / 2 + s, h / 2 + s, stroke);
                cv.drawLine(w / 2 + s, h / 2 - s, w / 2 - s, h / 2 + s, stroke);
            } else {
                path.reset();
                float cx = w / 2, cy = h / 2;
                path.moveTo(cx + 2 * d, cy - 11 * d);
                path.lineTo(cx - 6 * d, cy + 1.5f * d);
                path.lineTo(cx + 0.5f * d, cy + 1.5f * d);
                path.lineTo(cx - 2 * d, cy + 11 * d);
                path.lineTo(cx + 6 * d, cy - 1.5f * d);
                path.lineTo(cx - 0.5f * d, cy - 1.5f * d);
                path.close();
                cv.drawPath(path, stroke);
            }
        }
    }
}
