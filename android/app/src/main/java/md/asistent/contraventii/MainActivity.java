package md.asistent.contraventii;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.parseColor("#0a1f44"));
        getWindow().setNavigationBarColor(Color.parseColor("#0a1f44"));

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " AsistentAPK");

        web.addJavascriptInterface(new PrintBridge(), "AndroidPrint");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }
        });

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl("https://" + HOST + "/assets/index.html");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /** Tipărire nativă: pagina trimite PDF-ul (base64), Android deschide dialogul de tipărire (imprimantă, Wi-Fi sau „Salvează ca PDF”). */
    private class PrintBridge {
        @JavascriptInterface
        public void printPdf(final String base64, final String name, final int pages) {
            final byte[] data;
            try {
                data = Base64.decode(base64, Base64.DEFAULT);
            } catch (Exception e) {
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        String job = (name == null || name.length() == 0) ? "Blanc" : name;
                        PrintAttributes attrs = new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .build();
                        pm.print(job, new PdfAdapter(data, job, pages), attrs);
                    } catch (Exception ignored) { }
                }
            });
        }
    }

    private static class PdfAdapter extends PrintDocumentAdapter {
        private final byte[] data;
        private final String name;
        private final int pages;

        PdfAdapter(byte[] data, String name, int pages) {
            this.data = data;
            this.name = name;
            this.pages = pages;
        }

        @Override
        public void onLayout(PrintAttributes oldAttrs, PrintAttributes newAttrs, CancellationSignal cancel,
                             LayoutResultCallback callback, Bundle extras) {
            if (cancel.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name + ".pdf")
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                    .setPageCount(pages > 0 ? pages : PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                    .build();
            callback.onLayoutFinished(info, true);
        }

        @Override
        public void onWrite(PageRange[] range, ParcelFileDescriptor dest, CancellationSignal cancel,
                            WriteResultCallback callback) {
            OutputStream out = null;
            try {
                out = new FileOutputStream(dest.getFileDescriptor());
                out.write(data);
                out.flush();
                callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});
            } catch (IOException e) {
                callback.onWriteFailed(e.toString());
            } finally {
                try {
                    if (out != null) out.close();
                } catch (IOException ignored) { }
            }
        }
    }
}
