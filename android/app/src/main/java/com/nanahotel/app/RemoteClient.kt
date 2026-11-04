package com.nanahotel.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The connected app: shows the hosted NanaHotel server's pages (BuildConfig.SERVER_URL), which holds every API key.
 * Pages of the server and of the card form (LiteAPI's payment form on Stripe, including a bank's 3-D Secure step)
 * stay in the app, so the guest comes back to NanaHotel after paying. Every other link (Uber, Lyft, maps, email,
 * phone, a hotel's website) opens in the app that handles it.
 */
class RemoteClient(private val context: Context, private val server: Uri) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (url.scheme == "https" && staysInApp(url.host)) return false
        open(url)
        return true
    }

    private fun staysInApp(host: String?): Boolean {
        if (host == null) return false
        if (host == server.host) return true
        return PAYMENT_HOSTS.any { host == it || host.endsWith(".$it") }
    }

    private fun open(url: Uri) {
        try {
            val intent = if (url.scheme == "intent") {
                Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } else {
                Intent(Intent.ACTION_VIEW, url)
            }
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // Nothing on the phone opens this kind of link; the page stays as it is.
        }
    }

    // No connection (or the server can't be reached): a small page of our own with a Try again button.
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        view.loadDataWithBaseURL(null, offlinePage(server.toString()), "text/html", "utf-8", null)
    }

    companion object {
        /**
         * The card form: LiteAPI's payment wrapper and Stripe (its fields, and redirects such as 3-D Secure), plus the
         * pay-later and wallet options it offers (Klarna, Affirm, Afterpay, Cash App Pay, Amazon Pay), which send the
         * guest to their own pages and back.
         */
        val PAYMENT_HOSTS = listOf(
            "liteapi.travel", "stripe.com", "stripe.network", "stripecdn.com", "hcaptcha.com",
            "klarna.com", "affirm.com", "afterpay.com", "cash.app", "squareup.com",
            "amazon.com", "amazonpay.com", "payments-amazon.com",
        )

        private fun offlinePage(server: String): String {
            val target = server.replace("\\", "").replace("'", "%27").replace("<", "%3C")
            return """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 14px; padding: 24px;
    text-align: center; font: 16px/1.45 system-ui, sans-serif; background: #fbf5ea; color: #2a2118; }
  h1 { margin: 0; font-size: 20px; }
  p { margin: 0; color: #6a5a48; }
  button { justify-self: center; margin-top: 8px; padding: 12px 28px; border: 0; border-radius: 999px;
    font: 600 16px system-ui, sans-serif; background: #f5a217; color: #2a1a05; }
  @media (prefers-color-scheme: dark) { body { background: #13110e; color: #f6efe3; } p { color: #cbbfae; } }
</style></head><body>
<h1>Can't reach NanaHotel</h1>
<p>Check your internet connection, then try again.</p>
<button type="button" onclick="location.href='$target'">Try again</button>
</body></html>"""
        }
    }
}
