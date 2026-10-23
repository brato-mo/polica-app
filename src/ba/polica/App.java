package ba.polica;

import android.app.Application;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Keeps the last crash (stack trace) in a private file, so the settings can show what went wrong. Nothing is sent anywhere. */
public class App extends Application {
    static File crashFile(android.content.Context c) {
        return new File(c.getFilesDir(), "crash.txt");
    }

    @Override
    public void onCreate() {
        super.onCreate();
        final File f = crashFile(this);
        final Thread.UncaughtExceptionHandler old = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    String s = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()) + " " + t.getName() + "\n" + sw;
                    if (s.length() > 4000) s = s.substring(0, 4000);
                    FileOutputStream o = new FileOutputStream(f);
                    try {
                        o.write(s.getBytes("UTF-8"));
                    } finally {
                        o.close();
                    }
                } catch (Throwable ignored) {
                }
                if (old != null) old.uncaughtException(t, e);
            }
        });
    }
}
