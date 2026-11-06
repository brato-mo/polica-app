package android.content.pm;
public class PackageManager {
    public static int CODE = 1;
    public PackageInfo getPackageInfo(String n, int f) { PackageInfo p = new PackageInfo(); p.versionCode = CODE; return p; }
}
