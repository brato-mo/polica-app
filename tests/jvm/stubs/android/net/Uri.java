package android.net;
public final class Uri {
    final java.net.URI u; Uri(java.net.URI u) { this.u = u; }
    public static Uri parse(String s) { return new Uri(java.net.URI.create(s)); }
    public String getHost() { return u.getHost(); } public String getPath() { return u.getPath(); } public String getScheme() { return u.getScheme(); }
    public String toString() { return u.toString(); }
}
