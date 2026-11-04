package com.nina.xiaosu

import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * window.XiaosuNative: HTTPS requests for the page's model-provider (and web search) calls. The providers'
 * APIs don't allow cross-origin requests from a web page, so the app makes them and streams each response
 * back through window.__xiaosuHttp (see app/native-fetch.js). Only the providers' hosts are reachable.
 * The DeepSeek key built into the APK is added here, so the page never sees it.
 */
class HttpBridge(private val webView: WebView) {
    private val pool = Executors.newCachedThreadPool()
    private val connections = ConcurrentHashMap<String, HttpURLConnection>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()

    @JavascriptInterface
    fun start(id: String, url: String, method: String, headersJson: String, body: String) {
        pool.execute { run(id, url, method, headersJson, body) }
    }

    @JavascriptInterface
    fun hasBuiltInModel(): Boolean = BuildConfig.DEEPSEEK_API_KEY.isNotEmpty()

    @JavascriptInterface
    fun cancel(id: String) {
        cancelled.add(id)
        connections.remove(id)?.disconnect()
    }

    fun shutdown() {
        connections.values.forEach { it.disconnect() }
        pool.shutdownNow()
    }

    private fun run(id: String, url: String, method: String, headersJson: String, body: String) {
        var conn: HttpURLConnection? = null
        try {
            val target = URL(url)
            if (target.protocol != "https" || target.host !in ALLOWED_HOSTS) {
                throw IllegalArgumentException("不允许访问 ${target.host}")
            }
            conn = (target.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15_000
                readTimeout = 120_000
                instanceFollowRedirects = false
                // Streamed replies must arrive as they are written, not after a gzip buffer fills.
                setRequestProperty("Accept-Encoding", "identity")
                val headers = JSONObject(headersJson)
                val builtInKey = target.host == DEEPSEEK_HOST && BuildConfig.DEEPSEEK_API_KEY.isNotEmpty()
                for (key in headers.keys()) {
                    if (builtInKey && key.equals("authorization", ignoreCase = true)) continue
                    setRequestProperty(key, headers.getString(key))
                }
                if (builtInKey) setRequestProperty("Authorization", "Bearer ${BuildConfig.DEEPSEEK_API_KEY}")
            }
            connections[id] = conn
            if (cancelled.contains(id)) return
            if (body.isNotEmpty() && method != "GET" && method != "HEAD") {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val headers = JSONObject()
            for ((key, values) in conn.headerFields) {
                if (key != null) headers.put(key.lowercase(), values.joinToString(", "))
            }
            call("head", JSONObject.quote(id), status.toString(), JSONObject.quote(headers.toString()))
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            stream?.use { input ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) call("chunk", JSONObject.quote(id), JSONObject.quote(Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)))
                }
            }
            call("end", JSONObject.quote(id))
        } catch (e: Exception) {
            if (!cancelled.contains(id)) {
                call("fail", JSONObject.quote(id), JSONObject.quote(e.message ?: e.javaClass.simpleName))
            }
        } finally {
            connections.remove(id)
            cancelled.remove(id)
            conn?.disconnect()
        }
    }

    // Posts keep the calls in order; evaluateJavascript must run on the UI thread.
    private fun call(fn: String, vararg args: String) {
        val js = "window.__xiaosuHttp && window.__xiaosuHttp.$fn(${args.joinToString(",")})"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    companion object {
        private const val DEEPSEEK_HOST = "api.deepseek.com"

        /** Hosts of the providers in src/llm/providers.js, plus Bocha web search. */
        val ALLOWED_HOSTS = setOf(
            "api.deepseek.com",
            "dashscope.aliyuncs.com",
            "api.moonshot.cn",
            "open.bigmodel.cn",
            "ark.cn-beijing.volces.com",
            "api.bochaai.com",
        )
    }
}
