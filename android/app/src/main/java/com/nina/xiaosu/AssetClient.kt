package com.nina.xiaosu

import android.content.Context
import android.content.Intent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the bundled web app (assets/web: app/, public/, src/) from a fixed https origin, so ES modules,
 * the import map, localStorage and IndexedDB all work as on a normal site.
 */
class AssetClient(private val context: Context) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != HOST) return null
        val path = url.path?.removePrefix("/") ?: return null
        return try {
            WebResourceResponse(mimeType(path), "utf-8", context.assets.open(path))
        } catch (e: IOException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    // Links out of the app (e.g. web search results) open in the browser.
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.url.host == HOST) return false
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // no browser installed
        }
        return true
    }

    private fun mimeType(path: String) = when (path.substringAfterLast('.')) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "jpg", "jpeg" -> "image/jpeg"
        "json" -> "application/json"
        "wasm" -> "application/wasm"
        "webmanifest" -> "application/manifest+json"
        else -> "application/octet-stream"
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"

        fun url(page: String) = "https://$HOST/web/$page"
    }
}
