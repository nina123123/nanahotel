package com.nina.xiaosu

import android.annotation.SuppressLint
import android.app.Activity
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebView
import android.widget.FrameLayout

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var http: HttpBridge

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val background = getColor(R.color.bg)

        webView = WebView(this).apply {
            setBackgroundColor(background)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = AssetClient(applicationContext)
        }
        http = HttpBridge(webView)
        webView.addJavascriptInterface(http, "XiaosuNative")

        val root = FrameLayout(this)
        root.setBackgroundColor(background)
        root.addView(webView)
        setContentView(root)
        fitSystemBars(root)

        webView.loadUrl(AssetClient.url("app/index.html"))
    }

    // Draw behind the status and navigation bars (required from Android 15) and pad the content.
    private fun fitSystemBars(root: FrameLayout) {
        if (Build.VERSION.SDK_INT < 30) return
        window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(if (night) 0 else light, light)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        http.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Still the simplest way to intercept back on every supported version")
    override fun onBackPressed() {
        // Back closes the top sheet or dialog first (the page treats a cancel event like its close button).
        val js = "(function(){var d=document.querySelectorAll('dialog[open]');if(!d.length)return false;" +
            "d[d.length-1].dispatchEvent(new Event('cancel',{cancelable:true}));return true;})()"
        webView.evaluateJavascript(js) { handled ->
            if (handled != "true") super@MainActivity.onBackPressed()
        }
    }
}
