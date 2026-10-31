package com.example.arealharness

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "ArealKeychain")
class ArealKeychainPlugin : Plugin() {
    private lateinit var store: AndroidDeviceStore

    override fun load() {
        store = AndroidDeviceStore(context)
    }

    @PluginMethod
    fun load(call: PluginCall) {
        try {
            call.resolve(JSObject().put("value", store.load() ?: JSONObject.NULL))
        } catch (error: Exception) {
            call.reject("Device read failed", "KEYCHAIN_READ", error)
        }
    }

    @PluginMethod
    fun save(call: PluginCall) {
        try {
            store.save(call.getString("value"))
            call.resolve()
        } catch (error: Exception) {
            call.reject("Device write failed", "KEYCHAIN_WRITE", error)
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        try {
            store.clear()
            call.resolve()
        } catch (error: Exception) {
            call.reject("Device clear failed", "KEYCHAIN_CLEAR", error)
        }
    }

    @PluginMethod
    fun deviceName(call: PluginCall) {
        call.resolve(JSObject().put("name", Build.MODEL))
    }
}
