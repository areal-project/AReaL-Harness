package com.example.arealharness

import android.util.AtomicFile
import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import org.json.JSONObject

class DebugActivity : MainActivity() {
    override fun load() {
        val product = intent.getStringExtra("arealProduct")
        val probe = intent.getStringExtra("arealProbe")
        val config = product ?: probe
        if (config != null) {
            val view = findViewById<WebView>(com.getcapacitor.android.R.id.webview)
            check(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                "WebView does not support debug document-start gate"
            }
            val channel = if (product != null) "product" else "probe"
            val value = JSONObject(config)
            WebViewCompat.addWebMessageListener(view, "arealGate", setOf("https://localhost")) {
                _, message, _, mainFrame, _ ->
                if (!mainFrame) return@addWebMessageListener
                try {
                    val event = JSONObject(message.data)
                    val kind = event.getString("kind")
                    if (kind !in listOf("pairing", "ready", "background", "result")) return@addWebMessageListener
                    val file = AtomicFile(File(filesDir, "$channel-$kind.json"))
                    val output = file.startWrite()
                    try {
                        output.write(event.toString().toByteArray(Charsets.UTF_8))
                        file.finishWrite(output)
                    } catch (error: Exception) {
                        file.failWrite(output)
                        throw error
                    }
                } catch (error: Exception) {
                    Log.e("ArealGate", "Gate result failed", error)
                }
            }
            val name = if (product != null) "PRODUCT" else "PROBE"
            val handler = if (product != null) "arealProduct" else "arealProbe"
            WebViewCompat.addDocumentStartJavaScript(view,
                "window.__AREAL_MOBILE_${name}__=$value;" +
                    "window.webkit={messageHandlers:{$handler:{postMessage:value=>window.arealGate.postMessage(JSON.stringify(value))}}};",
                setOf("https://localhost"))
        }
        super.load()
    }
}
