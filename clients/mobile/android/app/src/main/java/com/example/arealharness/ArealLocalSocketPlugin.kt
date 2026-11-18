package com.example.arealharness

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URI
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLParameters
import javax.net.ssl.X509TrustManager
import org.java_websocket.client.WebSocketClient
import org.java_websocket.drafts.Draft_6455
import org.java_websocket.handshake.ServerHandshake

@CapacitorPlugin(name = "ArealLocalSocket")
class ArealLocalSocketPlugin : Plugin() {
    private val sockets = ConcurrentHashMap<String, WebSocketClient>()
    private val sends = ConcurrentHashMap<String, PluginCall>()
    private val drain = Executors.newSingleThreadScheduledExecutor()
    private val maxFrame = 512 * 1024

    private fun localURI(value: String, fingerprint: String?): URI {
        val uri = URI(value)
        require(fingerprint == null || fingerprint.matches(Regex("[a-f0-9]{64}")))
        require(uri.scheme == (if (fingerprint == null) "ws" else "wss") &&
            uri.rawUserInfo == null && uri.rawPath == "/remote/socket" &&
            uri.rawQuery == null && uri.rawFragment == null && (uri.port == -1 || uri.port in 1..65535))
        val host = requireNotNull(uri.host).removePrefix("[").removeSuffix("]")
        if (host.contains(':')) {
            require(host.matches(Regex("[0-9a-fA-F:]+")))
            val bytes = InetAddress.getByName(host).address
            require(bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc)
        } else {
            val parts = host.split('.')
            require(parts.size == 4 && parts.all { it.matches(Regex("0|[1-9][0-9]{0,2}")) && it.toInt() <= 255 })
            val a = parts[0].toInt()
            val b = parts[1].toInt()
            require(a in 1..223 && a != 127 && !(a == 169 && b == 254))
            val isPrivate = a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
            require(fingerprint != null || isPrivate ||
                isOnLink(parts.fold(0) { address, part -> (address shl 8) or part.toInt() }))
        }
        return uri
    }

    private fun pinContext(fingerprint: String): SSLContext {
        val expected = fingerprint.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                throw CertificateException("Unexpected client certificate")
            }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("Missing server certificate")
                val actual = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
                if (!MessageDigest.isEqual(expected, actual)) throw CertificateException("Local Relay certificate changed")
            }
        }
        return SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    }

    private fun isOnLink(destination: Int): Boolean {
        return NetworkInterface.getNetworkInterfaces().asSequence()
            .filter { it.isUp && !it.isLoopback && !it.isPointToPoint }
            .flatMap { it.interfaceAddresses.asSequence() }
            .any { interfaceAddress ->
                val prefix = interfaceAddress.networkPrefixLength.toInt()
                val broadcast = interfaceAddress.broadcast ?: return@any false
                if (prefix !in 1..30) return@any false
                val local = ByteBuffer.wrap(interfaceAddress.address.address).int
                val mask = -1 shl (32 - prefix)
                val network = local and mask
                (destination and mask) == network && destination != network &&
                    destination != ByteBuffer.wrap(broadcast.address).int
            }
    }

    private fun event(id: String, type: String, bytes: ByteArray? = null, text: Boolean = false) {
        val data = JSObject().put("id", id).put("type", type)
        if (bytes != null) data.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("text", text)
        notifyListeners("socketEvent", data)
    }

    private fun finish(id: String, failed: Boolean = false) {
        val socket = sockets.remove(id) ?: return
        sends.remove(id)?.reject("Local socket closed", "LOCAL_SOCKET_CLOSED")
        socket.closeConnection(1000, "")
        if (failed) event(id, "error")
        event(id, "close")
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        try {
            val id = requireNotNull(call.getString("id"))
            UUID.fromString(id)
            val fingerprint = call.getString("fingerprint")
            val uri = localURI(requireNotNull(call.getString("url")), fingerprint)
            require(sockets.size < 4 && !sockets.containsKey(id))
            val socket = object : WebSocketClient(uri, Draft_6455(emptyList(), maxFrame), mapOf("Origin" to "capacitor://localhost"), 15000) {
                override fun onSetSSLParameters(parameters: SSLParameters) {
                    super.onSetSSLParameters(parameters)
                    if (fingerprint != null) parameters.endpointIdentificationAlgorithm = null
                }
                override fun onOpen(handshake: ServerHandshake) { if (sockets[id] === this) event(id, "open") }
                override fun onMessage(message: String) {
                    val bytes = message.toByteArray(Charsets.UTF_8)
                    if (bytes.size > maxFrame) finish(id, true)
                    else if (sockets[id] === this) event(id, "message", bytes, true)
                }
                override fun onMessage(message: ByteBuffer) {
                    if (message.remaining() > maxFrame) { finish(id, true); return }
                    val bytes = ByteArray(message.remaining())
                    message.get(bytes)
                    if (sockets[id] === this) event(id, "message", bytes)
                }
                override fun onClose(code: Int, reason: String, remote: Boolean) { finish(id) }
                override fun onError(error: Exception) { finish(id, true) }
            }
            if (fingerprint != null) socket.setSocketFactory(pinContext(fingerprint).socketFactory)
            sockets[id] = socket
            socket.connect()
            call.resolve()
        } catch (error: Exception) {
            call.reject("Invalid local relay", "INVALID_LOCAL_RELAY", error)
        }
    }

    @PluginMethod
    fun send(call: PluginCall) {
        try {
            val id = requireNotNull(call.getString("id"))
            val value = requireNotNull(call.getString("data"))
            require(value.length <= ((maxFrame + 2) / 3) * 4)
            val bytes = Base64.decode(value, Base64.NO_WRAP)
            require(bytes.size <= maxFrame)
            val socket = requireNotNull(sockets[id])
            require(socket.isOpen && sends.putIfAbsent(id, call) == null)
            try {
                if (call.getBoolean("text", false) == true) socket.send(String(bytes, Charsets.UTF_8))
                else socket.send(bytes)
                awaitDrain(id, socket, call, System.nanoTime() + TimeUnit.SECONDS.toNanos(15))
            } catch (error: Exception) {
                sends.remove(id, call)
                throw error
            }
        } catch (error: Exception) {
            call.reject("Local send failed", "LOCAL_SEND_FAILED", error)
        }
    }

    private fun awaitDrain(id: String, socket: WebSocketClient, call: PluginCall, deadline: Long) {
        drain.schedule({
            if (sends[id] !== call) return@schedule
            if (sockets[id] !== socket || !socket.isOpen || System.nanoTime() >= deadline) {
                finish(id, true)
            } else if (!socket.hasBufferedData()) {
                if (sends.remove(id, call)) call.resolve()
            } else awaitDrain(id, socket, call, deadline)
        }, 5, TimeUnit.MILLISECONDS)
    }

    @PluginMethod
    fun close(call: PluginCall) {
        call.getString("id")?.let { finish(it) }
        call.resolve()
    }

    override fun handleOnDestroy() {
        sockets.keys.toList().forEach { finish(it) }
        drain.shutdownNow()
        super.handleOnDestroy()
    }
}
