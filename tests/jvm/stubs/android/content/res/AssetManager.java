package android.content.res;
public class AssetManager {
    public java.io.InputStream open(String n) throws java.io.IOException { return new java.io.FileInputStream(System.getProperty("assets", "assets") + "/" + n); }
}
