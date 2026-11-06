package android.webkit;
public class WebViewClient {
    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return false; }
    public void onPageFinished(WebView v, String url) {}
    public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {}
    public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return null; }
}
