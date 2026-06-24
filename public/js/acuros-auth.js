/* acuros-auth.js — shared Supabase session storage for *.acuros.ca
 *
 * Why this exists: the developer console lives on dev.acuros.ca, a different
 * ORIGIN from acuros.ca. Browsers don't share localStorage across origins, so
 * a user signed in on acuros.ca would land on dev.acuros.ca signed out. This
 * adapter makes the Supabase session a cookie scoped to `.acuros.ca`, which IS
 * shared across acuros.ca, www.acuros.ca and dev.acuros.ca.
 *
 * ── The S2 bug this version fixes ("logins get invalid fast") ───────────────
 * Supabase ROTATES the refresh token on every refresh and REVOKES the whole
 * session family if a stale refresh token is replayed. The previous adapter's
 * getItem PREFERRED localStorage over the cookie. localStorage is per-origin
 * and is never synced between acuros.ca and dev.acuros.ca, so each origin could
 * hold a DIFFERENT (older) token and replay it on its next refresh — tripping
 * reuse detection and silently killing the session minutes after sign-in.
 *
 * The fix: getItem is now EXPIRY-AWARE. When localStorage and the shared cookie
 * disagree, it returns whichever session expires LATER (i.e. the most recently
 * rotated one) and mirrors that winner back into BOTH stores so every origin
 * converges on the same, newest token before it ever tries to refresh. This
 * removes the stale-token replay that caused the revocations.
 *
 * Design — dual write (localStorage + cookie):
 *   • setItem writes BOTH localStorage and the cookie. localStorage keeps every
 *     existing acuros.ca code path working unchanged (legacy readers use
 *     window.acurosAuth.* helpers below instead of touching the raw key).
 *   • The cookie (scoped to .acuros.ca) is what dev.acuros.ca reads.
 *   • removeItem (sign-out) clears both.
 *
 * Off acuros.ca (localhost, *.vercel.app previews) it writes a host-only cookie
 * instead of a .acuros.ca cookie, so dev/preview still persist sessions.
 *
 * Cookies are chunked because a Supabase session can exceed the ~4 KB per-cookie
 * limit once URL-encoded.
 */
(function () {
  var host = location.hostname || '';
  var onAcuros = /(^|\.)acuros\.ca$/i.test(host);
  var COOKIE_DOMAIN = onAcuros ? '; domain=.acuros.ca' : '';
  var SECURE = location.protocol === 'https:' ? '; secure' : '';
  var MAXAGE = 60 * 60 * 24 * 400; // 400 days
  var CHUNK = 3000;                // safe per-cookie payload (name + attrs fit under ~4 KB)

  var STORAGE_KEY = (window.ACUROS && window.ACUROS.STORAGE_KEY) || null;

  function writeCookie(name, value) {
    document.cookie = name + '=' + value + COOKIE_DOMAIN + '; path=/; max-age=' + MAXAGE + SECURE + '; samesite=lax';
  }
  function deleteCookie(name) {
    document.cookie = name + '=' + COOKIE_DOMAIN + '; path=/; max-age=0' + SECURE + '; samesite=lax';
  }
  function readCookie(name) {
    var esc = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    var m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'));
    return m ? m[1] : null;
  }

  function setCookieChunked(key, value) {
    removeCookieChunked(key);
    var enc = encodeURIComponent(value);
    if (enc.length <= CHUNK) { writeCookie(key, enc); return; }
    var n = Math.ceil(enc.length / CHUNK);
    writeCookie(key + '.chunks', String(n));
    for (var i = 0; i < n; i++) writeCookie(key + '.' + i, enc.slice(i * CHUNK, (i + 1) * CHUNK));
  }
  function getCookieChunked(key) {
    var single = readCookie(key);
    if (single !== null) { try { return decodeURIComponent(single); } catch (_e) { return single; } }
    var nRaw = readCookie(key + '.chunks');
    if (!nRaw) return null;
    var n = parseInt(nRaw, 10);
    if (!(n > 0)) return null;
    var out = '';
    for (var i = 0; i < n; i++) {
      var part = readCookie(key + '.' + i);
      if (part === null) return null; // incomplete — treat as absent
      out += part;
    }
    try { return decodeURIComponent(out); } catch (_e) { return out; }
  }
  function removeCookieChunked(key) {
    deleteCookie(key);
    var nRaw = readCookie(key + '.chunks');
    if (nRaw) {
      var n = parseInt(nRaw, 10) || 0;
      for (var i = 0; i < n; i++) deleteCookie(key + '.' + i);
      deleteCookie(key + '.chunks');
    }
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (_e) { return null; } }
  function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (_e) {} }

  // Pull the session's absolute expiry (unix seconds) out of the stored JSON.
  // Returns -1 when unparseable so a parseable session always wins over junk.
  function sessionExpiry(raw) {
    if (!raw) return -1;
    try {
      var o = JSON.parse(raw);
      var e = o && (o.expires_at || (o.currentSession && o.currentSession.expires_at));
      return typeof e === 'number' ? e : -1;
    } catch (_e) { return -1; }
  }

  var storage = {
    // Expiry-aware read: return the NEWEST session across localStorage + cookie
    // and converge both stores onto it so no origin can replay a stale token.
    getItem: function (key) {
      var ls = lsGet(key);
      var ck = getCookieChunked(key);
      if (ls === null && ck === null) return null;
      if (ls === null) { lsSet(key, ck); return ck; }
      if (ck === null) { try { setCookieChunked(key, ls); } catch (_e) {} return ls; }
      if (ls === ck) return ls;
      // Disagreement → keep whichever expires later (the most recently rotated).
      var winner = sessionExpiry(ck) >= sessionExpiry(ls) ? ck : ls;
      lsSet(key, winner);
      try { setCookieChunked(key, winner); } catch (_e) {}
      return winner;
    },
    setItem: function (key, value) {
      lsSet(key, value);
      try { setCookieChunked(key, value); } catch (_e) {}
    },
    removeItem: function (key) {
      try { localStorage.removeItem(key); } catch (_e) {}
      try { removeCookieChunked(key); } catch (_e) {}
    }
  };

  // ── Shared, cross-subdomain UI flags ──────────────────────────────────────
  // Role/initial were previously stored ONLY in per-origin localStorage, so on
  // dev.acuros.ca (empty localStorage) an owner looked like a signed-out
  // visitor. Mirror them into the .acuros.ca cookie too.
  function setFlag(name, value) {
    lsSet(name, value);
    try { writeCookie(name, encodeURIComponent(value)); } catch (_e) {}
  }
  function getFlag(name) {
    var v = lsGet(name);
    if (v !== null) return v;
    var c = readCookie(name);
    if (c === null) return null;
    try { return decodeURIComponent(c); } catch (_e) { return c; }
  }
  function clearFlag(name) {
    try { localStorage.removeItem(name); } catch (_e) {}
    deleteCookie(name);
  }

  // ── Public helper API ─────────────────────────────────────────────────────
  // Pages MUST use these instead of reading the raw sb-…-auth-token key, so
  // signed-in state is detected on dev.acuros.ca (cookie) as well as the apex.
  window.acurosAuth = {
    STORAGE_KEY: STORAGE_KEY,
    // The raw stored session JSON (localStorage-or-cookie, newest), or null.
    rawSession: function () { return STORAGE_KEY ? storage.getItem(STORAGE_KEY) : null; },
    // True when a non-expired access token is present.
    isSignedIn: function () {
      var raw = this.rawSession();
      if (!raw) return false;
      var exp = sessionExpiry(raw);
      // exp is unix seconds; allow a small skew. -1 (unparseable) → treat as not signed in.
      return exp === -1 ? false : (exp * 1000 > Date.now() - 5000);
    },
    setRole: function (role) { if (role) setFlag('ah-user-role', role); },
    getRole: function () { return getFlag('ah-user-role'); },
    setInitial: function (i) { if (i) setFlag('ah-user-initial', i); },
    getInitial: function () { return getFlag('ah-user-initial'); },
    // Wipe every trace of the session + flags across both stores. Use on sign-out.
    clearAll: function () {
      if (STORAGE_KEY) storage.removeItem(STORAGE_KEY);
      clearFlag('ah-user-role');
      clearFlag('ah-user-initial');
      try {
        Object.keys(localStorage).forEach(function (k) { if (k.indexOf('sb-') === 0) localStorage.removeItem(k); });
      } catch (_e) {}
    },
  };

  // Drop-in replacement for window.supabase.createClient that shares the
  // session across *.acuros.ca. Same default auth behaviour otherwise.
  window.createAcurosClient = function (url, key, opts) {
    opts = opts || {};
    var auth = Object.assign({
      storage: storage,
      storageKey: STORAGE_KEY || undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }, opts.auth || {});
    return window.supabase.createClient(url, key, Object.assign({}, opts, { auth: auth }));
  };
})();
