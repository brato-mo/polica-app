package android.content;
public interface SharedPreferences {
    String getString(String k, String d);
    boolean getBoolean(String k, boolean d);
    int getInt(String k, int d);
    Editor edit();
    interface Editor { Editor putString(String k, String v); Editor putBoolean(String k, boolean v); Editor putInt(String k, int v); Editor remove(String k); void apply(); boolean commit(); }
}
