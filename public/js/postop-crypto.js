/* postop-crypto.js — end-to-end encryption for Acuros Post-Op Care.
 *
 * Threat model / guarantees:
 *   • Message text and photos are encrypted IN THE BROWSER before anything
 *     leaves the device. Supabase (and Acuros' servers) only ever store
 *     ciphertext — postop_messages.body_cipher and the blobs in the private
 *     postop-media bucket are opaque bytes without the participants' keys.
 *   • Each participant holds an ECDH P-256 keypair. The PRIVATE key never
 *     leaves this device (localStorage, per Supabase user id). Only the
 *     PUBLIC JWK is published to public.postop_keys.
 *   • A per-case AES-256-GCM key is derived with ECDH + HKDF-SHA-256, salted
 *     by the case id, so every case has an independent key. ECDH symmetry
 *     means patient and clinic derive the same key from opposite key halves —
 *     nothing key-like is ever transmitted.
 *   • Consequence (by design): if a user clears site data or switches devices
 *     without importing their key backup, existing threads CANNOT be
 *     decrypted — not by them, not by Acuros. exportBackup()/importBackup()
 *     exist for device transfer.
 *
 * Wire formats:
 *   text  → base64( 12-byte IV ‖ AES-GCM ciphertext )   in body_cipher
 *   bytes → Uint8Array( 12-byte IV ‖ AES-GCM ciphertext ) uploaded as
 *           application/octet-stream to postop-media/case_<caseId>/<uuid>.bin
 */
(function () {
  'use strict';

  var CURVE = 'P-256';
  var HKDF_INFO = 'acuros-postop-v1';
  var LS_PREFIX = 'ah-postop-key-';

  var subtle = (window.crypto && window.crypto.subtle) || null;
  var te = new TextEncoder();
  var td = new TextDecoder();

  function lsKey(userId) { return LS_PREFIX + userId; }

  // ── base64 helpers (chunked: photos exceed apply() argument limits) ──────
  function bytesToB64(bytes) {
    var CHUNK = 0x8000, bin = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function importPriv(jwk) {
    return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
  }
  function importPub(jwk) {
    return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: CURVE }, false, []);
  }

  function readLocal(userId) {
    try {
      var raw = localStorage.getItem(lsKey(userId));
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.privateJwk || !o.publicJwk) return null;
      return o;
    } catch (_e) { return null; }
  }
  function writeLocal(userId, pair) {
    localStorage.setItem(lsKey(userId), JSON.stringify(pair));
  }

  async function generatePair() {
    var kp = await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits']);
    var privateJwk = await subtle.exportKey('jwk', kp.privateKey);
    var publicJwk = await subtle.exportKey('jwk', kp.publicKey);
    return { privateJwk: privateJwk, publicJwk: publicJwk, createdAt: new Date().toISOString() };
  }

  async function publishPublicKey(sb, userId, publicJwk, orgId) {
    var row = { user_id: userId, public_jwk: publicJwk, org_id: orgId || null, updated_at: new Date().toISOString() };
    var res = await sb.from('postop_keys').upsert(row, { onConflict: 'user_id' });
    if (res.error) throw new Error('Could not publish secure-messaging key: ' + res.error.message);
  }

  window.PostopCrypto = {
    supported: !!subtle,

    hasLocalKey: function (userId) { return !!readLocal(userId); },

    /* Resolve this device's keypair.
     * Returns { status:'ready', pair } when a usable local key exists (and
     * re-publishes the public half so the directory row always matches).
     * Returns { status:'missing-local', remoteJwk } when the server already
     * has a key for this user but this device doesn't hold the private half —
     * the caller must ask the user to import a backup or regenerate
     * (regenerating makes PREVIOUS threads permanently undecryptable). */
    ensureKeys: async function (sb, userId, orgId) {
      if (!subtle) throw new Error('This browser does not support the encryption APIs (WebCrypto).');
      var local = readLocal(userId);
      if (local) {
        await publishPublicKey(sb, userId, local.publicJwk, orgId);
        return { status: 'ready', pair: local };
      }
      var remote = await sb.from('postop_keys').select('public_jwk').eq('user_id', userId).maybeSingle();
      if (remote.data && remote.data.public_jwk) {
        return { status: 'missing-local', remoteJwk: remote.data.public_jwk };
      }
      var pair = await generatePair();
      writeLocal(userId, pair);
      await publishPublicKey(sb, userId, pair.publicJwk, orgId);
      return { status: 'ready', pair: pair, fresh: true };
    },

    /* Explicit regeneration after the user confirms they understand old
     * threads become unreadable. */
    regenerate: async function (sb, userId, orgId) {
      var pair = await generatePair();
      writeLocal(userId, pair);
      await publishPublicKey(sb, userId, pair.publicJwk, orgId);
      return pair;
    },

    /* Key backup for device transfer. The file contains the PRIVATE key —
     * the UI must present it as sensitive. */
    exportBackup: function (userId) {
      var local = readLocal(userId);
      if (!local) return null;
      return JSON.stringify({
        format: 'acuros-postop-key',
        version: 1,
        userId: userId,
        privateJwk: local.privateJwk,
        publicJwk: local.publicJwk,
        exportedAt: new Date().toISOString()
      }, null, 2);
    },

    importBackup: async function (sb, userId, orgId, fileText) {
      var o;
      try { o = JSON.parse(fileText); } catch (_e) { throw new Error('That file is not a valid key backup.'); }
      if (!o || o.format !== 'acuros-postop-key' || !o.privateJwk || !o.publicJwk) {
        throw new Error('That file is not an Acuros post-op key backup.');
      }
      if (o.userId && o.userId !== userId) {
        throw new Error('This backup belongs to a different Acuros account.');
      }
      await importPriv(o.privateJwk); // validates the key material
      var pair = { privateJwk: o.privateJwk, publicJwk: o.publicJwk, createdAt: o.exportedAt || new Date().toISOString() };
      writeLocal(userId, pair);
      await publishPublicKey(sb, userId, pair.publicJwk, orgId);
      return pair;
    },

    /* ECDH(myPrivate, theirPublic) → HKDF(salt=caseId) → AES-256-GCM key.
     * Symmetric: both parties derive the identical key. */
    deriveCaseKey: async function (myPrivateJwk, theirPublicJwk, caseId) {
      var priv = await importPriv(myPrivateJwk);
      var pub = await importPub(theirPublicJwk);
      var secret = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
      var hkdfKey = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
      return subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: te.encode(String(caseId)), info: te.encode(HKDF_INFO) },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    },

    encryptBytes: async function (key, bytes) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, bytes));
      var out = new Uint8Array(iv.length + ct.length);
      out.set(iv, 0);
      out.set(ct, iv.length);
      return out;
    },

    decryptBytes: async function (key, buf) {
      var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (bytes.length < 13) throw new Error('Ciphertext too short.');
      var iv = bytes.subarray(0, 12);
      var ct = bytes.subarray(12);
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct));
    },

    encryptText: async function (key, text) {
      return bytesToB64(await this.encryptBytes(key, te.encode(text)));
    },

    decryptText: async function (key, b64) {
      return td.decode(await this.decryptBytes(key, b64ToBytes(b64)));
    }
  };
})();
