package ba.polica;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The sign-in for the planogram server, kept on the phone only: encrypted with a key that lives in the phone's
 * key store (Android Keystore) and never leaves it. Nothing is sent anywhere except to the planogram server itself.
 */
final class Secret {
    private static final String ALIAS = "plans-login";
    private static final String PREFS = "plans-login";

    private Secret() {
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return g.generateKey();
    }

    static boolean save(Context c, String user, String pass) {
        try {
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, key());
            byte[] data = ci.doFinal((user + "\n" + pass).getBytes(StandardCharsets.UTF_8));
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("iv", Base64.encodeToString(ci.getIV(), Base64.NO_WRAP))
                .putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
                .apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** {user, password}, or null when nothing is kept. */
    static String[] load(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String iv = p.getString("iv", null), data = p.getString("data", null);
        if (iv == null || data == null) return null;
        try {
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            String s = new String(ci.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8);
            int i = s.indexOf('\n');
            return i < 0 ? null : new String[] {s.substring(0, i), s.substring(i + 1)};
        } catch (Exception e) {
            return null;
        }
    }

    static void clear(Context c) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }
}
