package com.korvi.cashier.identity

import android.app.Activity
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SignArgs { lateinit var payload: String }

@InvokeArg
class ProtectArgs {
    lateinit var plaintextBase64: String
    lateinit var aadBase64: String
}

@InvokeArg
class UnprotectArgs {
    lateinit var protectedBase64: String
    lateinit var aadBase64: String
}

@TauriPlugin
class DeviceIdentityPlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "com.korvi.cashier.device.identity.v1"
    private val localStoreAlias = "com.korvi.cashier.local.store.v1"
    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun createKey(strongBox: Boolean) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
        generator.initialize(builder.build())
        generator.generateKeyPair()
    }

    private fun ensureKey() {
        if (store().containsAlias(alias)) return
        val wantsStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && activity.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
        if (wantsStrongBox) {
            try { createKey(true); return } catch (_: StrongBoxUnavailableException) { }
        }
        createKey(false)
    }

    private fun createLocalStoreKey(strongBox: Boolean) {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val builder = KeyGenParameterSpec.Builder(
            localStoreAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setKeySize(256)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
        generator.init(builder.build())
        generator.generateKey()
    }

    private fun ensureLocalStoreKey(): SecretKey {
        val keyStore = store()
        val existing = keyStore.getKey(localStoreAlias, null)
        if (existing is SecretKey) return existing
        val wantsStrongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && activity.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
        if (wantsStrongBox) {
            try { createLocalStoreKey(true) } catch (_: StrongBoxUnavailableException) { createLocalStoreKey(false) }
        } else {
            createLocalStoreKey(false)
        }
        return store().getKey(localStoreAlias, null) as? SecretKey
            ?: throw IllegalStateException("local-store key unavailable")
    }

    private fun decode(value: String): ByteArray = Base64.decode(value, Base64.DEFAULT)
    private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)
    private fun publicEncoded(): ByteArray { ensureKey(); return store().getCertificate(alias).publicKey.encoded }
    private fun keyInfo(): KeyInfo {
        ensureKey(); val privateKey = store().getKey(alias, null)
        return KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore").getKeySpec(privateKey, KeyInfo::class.java)
    }
    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    private fun installationId(hash: ByteArray): String {
        val b = hash.copyOfRange(0, 16); b[6] = ((b[6].toInt() and 0x0f) or 0x50).toByte(); b[8] = ((b[8].toInt() and 0x3f) or 0x80).toByte()
        val h = hex(b); return "${h.substring(0,8)}-${h.substring(8,12)}-${h.substring(12,16)}-${h.substring(16,20)}-${h.substring(20,32)}"
    }

    @Command
    fun identity(invoke: Invoke) {
        try {
            val public = publicEncoded(); val digest = MessageDigest.getInstance("SHA-256").digest(public); val info = keyInfo()
            val strong = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
            val ret = JSObject(); ret.put("installationId", installationId(digest)); ret.put("keyAlgorithm", "p256")
            ret.put("publicKeySpki", Base64.encodeToString(public, Base64.NO_WRAP)); ret.put("publicKeySha256", hex(digest))
            ret.put("strongboxBacked", strong); ret.put("hardwareBacked", info.isInsideSecureHardware)
            ret.put("custody", if (strong) "android-keystore-strongbox" else if (info.isInsideSecureHardware) "android-keystore-hardware" else "android-keystore")
            invoke.resolve(ret)
        } catch (error: Exception) { invoke.reject("Android Keystore identity unavailable: ${error.javaClass.simpleName}") }
    }

    @Command
    fun sign(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SignArgs::class.java); ensureKey(); val privateKey = store().getKey(alias, null)
            val signer = Signature.getInstance("SHA256withECDSA"); signer.initSign(privateKey); signer.update(args.payload.toByteArray(Charsets.UTF_8))
            val ret = JSObject(); ret.put("signature", Base64.encodeToString(signer.sign(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)); invoke.resolve(ret)
        } catch (error: Exception) { invoke.reject("Android Keystore signing failed: ${error.javaClass.simpleName}") }
    }

    @Command
    fun protect(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ProtectArgs::class.java)
            val plaintext = decode(args.plaintextBase64)
            val aad = decode(args.aadBase64)
            require(plaintext.isNotEmpty() && aad.isNotEmpty())
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, ensureLocalStoreKey())
            cipher.updateAAD(aad)
            val ciphertext = cipher.doFinal(plaintext)
            val packed = ByteArray(cipher.iv.size + ciphertext.size)
            System.arraycopy(cipher.iv, 0, packed, 0, cipher.iv.size)
            System.arraycopy(ciphertext, 0, packed, cipher.iv.size, ciphertext.size)
            val ret = JSObject(); ret.put("protectedBase64", encode(packed)); invoke.resolve(ret)
        } catch (error: Exception) { invoke.reject("Android Keystore local-store protection failed: ${error.javaClass.simpleName}") }
    }

    @Command
    fun unprotect(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(UnprotectArgs::class.java)
            val packed = decode(args.protectedBase64)
            val aad = decode(args.aadBase64)
            require(packed.size > 28 && aad.isNotEmpty())
            val iv = packed.copyOfRange(0, 12)
            val ciphertext = packed.copyOfRange(12, packed.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, ensureLocalStoreKey(), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            val plaintext = cipher.doFinal(ciphertext)
            val ret = JSObject(); ret.put("plaintextBase64", encode(plaintext)); invoke.resolve(ret)
        } catch (error: Exception) { invoke.reject("Android Keystore refused local-store ciphertext or binding metadata: ${error.javaClass.simpleName}") }
    }
}
