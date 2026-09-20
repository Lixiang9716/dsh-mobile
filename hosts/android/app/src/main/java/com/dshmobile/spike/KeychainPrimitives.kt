package com.dshmobile.spike

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * keychainGet / keychainSet (contract/primitives.md §4) over the Android
 * Keystore — the platform analogue of hosts/ios KeychainPrimitives.swift's
 * SecItem generic-password items. AndroidKeyStore stores KEYS, not blobs, so
 * a secret is sealed with a hardware-backed AES-256-GCM key (created once
 * under the fixed alias) and the ciphertext persists in the app-private
 * `<filesDir>/keychain/<sha256(ref)>` — service = application id, account =
 * the opaque KeyRef, same trust level as iOS' item lookup. An unset ref
 * reads as null; `keychainSet(ref, null)` deletes; set on a missing ref adds,
 * on an existing ref overwrites. The descriptor declares keychain* available
 * — never faked (conformance §7).
 */
class KeychainPrimitives(private val context: Context) {

    companion object {
        private const val KEY_ALIAS = "dsh-keychain-master"
        private const val GCM_TAG_BITS = 128

        private fun invalid(primitive: String, message: String) =
            GatewayCore.GatewayError("invalid", primitive, message)

        private fun io(primitive: String, message: String) =
            GatewayCore.GatewayError("io", primitive, message)

        private fun b64(bytes: ByteArray): String =
            java.util.Base64.getEncoder().encodeToString(bytes)
    }

    private val dir = File(context.filesDir, "keychain").apply { mkdirs() }

    fun register(on: GatewayCore) {
        on.register("keychainGet") { call, done -> get(call, done) }
        on.register("keychainSet") { call, done -> set(call, done) }
    }

    private fun fileFor(ref: String): File {
        val name = MessageDigest.getInstance("SHA-256").digest(ref.toByteArray())
            .joinToString("") { "%02x".format(it) }
        return File(dir, name)
    }

    private fun get(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val ref = call.string("ref")
        if (ref.isNullOrEmpty()) return done.settle(null, invalid("keychainGet", "empty ref"))
        try {
            val file = fileFor(ref)
            if (!file.isFile) return done.settle(null, null) // unset ref reads null
            val blob = file.readBytes()
            val iv = blob.copyOfRange(0, 12)
            val ciphertext = blob.copyOfRange(12, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, masterKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            done.settle(JSONObject().put("secretB64", b64(cipher.doFinal(ciphertext))), null)
        } catch (e: Exception) {
            done.settle(null, io("keychainGet", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    private fun set(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val ref = call.string("ref")
        if (ref.isNullOrEmpty()) return done.settle(null, invalid("keychainSet", "empty ref"))
        try {
            if (call.args.isNull("secretB64")) {
                fileFor(ref).delete() // keychainSet(ref, null) deletes
                return done.settle(null, null)
            }
            val bytes = java.util.Base64.getDecoder().decode(call.args.getString("secretB64"))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, masterKey())
            val blob = cipher.iv + cipher.doFinal(bytes)
            fileFor(ref).writeBytes(blob)
            done.settle(null, null)
        } catch (e: Exception) {
            done.settle(null, io("keychainSet", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    /** The fixed-alias AES key: created on first use, never extractable. */
    private fun masterKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore",
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }
}
