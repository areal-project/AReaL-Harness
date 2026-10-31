package com.example.arealharness

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal class AndroidDeviceStore(context: Context) {
    companion object {
        const val MAX_BYTES = 262144
    }

    private val record = AtomicFile(File(context.noBackupFilesDir, "remote-device.enc"))
    private val alias = "${context.packageName}.remote-device"

    private fun keys(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(create: Boolean): SecretKey {
        val keys = keys()
        if (keys.containsAlias(alias)) return keys.getKey(alias, null) as SecretKey
        check(create) { "Device key unavailable" }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun exists() = record.baseFile.exists() || File("${record.baseFile.path}.bak").exists()

    @Synchronized
    fun load(): String? {
        if (!exists()) return null
        val bytes = record.openRead().use { input ->
            val buffer = ByteArrayOutputStream()
            val block = ByteArray(8192)
            var count = input.read(block)
            while (count != -1) {
                buffer.write(block, 0, count)
                check(buffer.size() <= MAX_BYTES * 2) { "Device record too large" }
                count = input.read(block)
            }
            buffer.toByteArray()
        }
        val envelope = JSONObject(bytes.toString(Charsets.UTF_8))
        check(envelope.getInt("version") == 1) { "Device record version invalid" }
        val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
        val ciphertext = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
        check(iv.size == 12) { "Device record IV invalid" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, iv))
        cipher.updateAAD(alias.toByteArray(Charsets.UTF_8))
        val plaintext = cipher.doFinal(ciphertext)
        check(plaintext.size <= MAX_BYTES) { "Device record too large" }
        return plaintext.toString(Charsets.UTF_8)
    }

    @Synchronized
    fun save(value: String?) {
        require(value != null && value.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Invalid device record" }
        if (exists()) load()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        cipher.updateAAD(alias.toByteArray(Charsets.UTF_8))
        val envelope = JSONObject()
            .put("version", 1)
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
        var output: FileOutputStream? = null
        try {
            output = record.startWrite()
            output.write(envelope.toString().toByteArray(Charsets.UTF_8))
            output.fd.sync()
            record.finishWrite(output)
            check(value == load()) { "Device write did not commit" }
        } catch (error: Exception) {
            record.failWrite(output)
            throw error
        }
    }

    @Synchronized
    fun clear() {
        record.delete()
        check(!exists()) { "Device clear failed" }
        keys().deleteEntry(alias)
    }
}
