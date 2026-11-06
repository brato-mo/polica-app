package android.webkit;
public class CookieManager { static final CookieManager I = new CookieManager(); public static CookieManager getInstance() { return I; } public void setAcceptCookie(boolean b) {} public void setAcceptThirdPartyCookies(WebView w, boolean b) {} public void flush() {} }
