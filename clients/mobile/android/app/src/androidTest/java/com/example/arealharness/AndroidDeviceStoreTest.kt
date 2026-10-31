package com.example.arealharness

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidDeviceStoreTest {
    companion object {
        private const val VALUE = """{"schema":1,"identity":"PRIVATE_ANDROID_IDENTITY_SENTINEL","locators":["UNKNOWN_SENTINEL"]}"""
    }

    @Test
    fun encryptedStorage() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = AndroidDeviceStore(context)
        val file = File(context.noBackupFilesDir, "remote-device.enc")
        val stage = InstrumentationRegistry.getArguments().getString("stage", "all")
        if (stage == "restore") {
            assertEquals(VALUE, store.load())
            store.clear()
            assertNull(store.load())
            return
        }
        store.clear()
        assertNull(store.load())
        store.save(VALUE)
        assertEquals(VALUE, AndroidDeviceStore(context).load())
        val disk = file.readText(Charsets.UTF_8)
        assertFalse(disk.contains("PRIVATE_ANDROID_IDENTITY_SENTINEL"))
        assertFalse(disk.contains("UNKNOWN_SENTINEL"))
        if (stage == "save") return
        assertThrows(IllegalArgumentException::class.java) { store.save("x".repeat(AndroidDeviceStore.MAX_BYTES + 1)) }
        assertEquals(VALUE, store.load())
        file.writeText("corrupt", Charsets.UTF_8)
        assertThrows(Exception::class.java) { store.load() }
        assertThrows(Exception::class.java) { store.save("replacement") }
        assertEquals("corrupt", file.readText(Charsets.UTF_8))
        store.clear()
        store.save(VALUE)
        val envelope = JSONObject(file.readText(Charsets.UTF_8))
        val ciphertext = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
        ciphertext[0] = (ciphertext[0].toInt() xor 1).toByte()
        envelope.put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        file.writeText(envelope.toString(), Charsets.UTF_8)
        assertThrows(Exception::class.java) { store.load() }
        assertThrows(Exception::class.java) { store.save("replacement") }
        store.clear()
        store.save(VALUE)
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keys.deleteEntry("${context.packageName}.remote-device")
        assertThrows(Exception::class.java) { store.load() }
        assertThrows(Exception::class.java) { store.save("replacement") }
        store.clear()
        assertNull(store.load())
    }
}
