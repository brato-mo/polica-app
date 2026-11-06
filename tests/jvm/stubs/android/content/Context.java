package android.content;
import java.io.File;
/** Test stand-in: a files folder, string resources and preferences in memory, assets from the project. */
public class Context {
    public static final int MODE_PRIVATE = 0;
    public final File files; public final java.util.Map<Integer, String> strings = new java.util.HashMap<>();
    final java.util.Map<String, String> prefs = new java.util.HashMap<>();
    public Context(File files) { this.files = files; }
    public File getFilesDir() { return files; }
    public Context getApplicationContext() { return this; }
    public android.content.pm.PackageManager getPackageManager() { return new android.content.pm.PackageManager(); }
    public String getPackageName() { return "ba.polica"; }
    public String getString(int id) { String s = strings.get(id); if (s == null) throw new RuntimeException("no string " + id); return s; }
    public android.content.res.AssetManager getAssets() { return new android.content.res.AssetManager(); }
    public SharedPreferences getSharedPreferences(String n, int m) {
        return new SharedPreferences() {
            public String getString(String k, String d) { String v = prefs.get(n + "/" + k); return v == null ? d : v; }
            public boolean getBoolean(String k, boolean d) { String v = prefs.get(n + "/" + k); return v == null ? d : Boolean.parseBoolean(v); }
            public int getInt(String k, int d) { String v = prefs.get(n + "/" + k); return v == null ? d : Integer.parseInt(v); }
            public Editor edit() { return new Editor() {
                public Editor putString(String k, String v) { prefs.put(n + "/" + k, v); return this; }
                public Editor putBoolean(String k, boolean v) { prefs.put(n + "/" + k, "" + v); return this; }
                public Editor putInt(String k, int v) { prefs.put(n + "/" + k, "" + v); return this; }
                public Editor remove(String k) { prefs.remove(n + "/" + k); return this; }
                public void apply() {} public boolean commit() { return true; } }; }
        };
    }
}
