/* acuros-auth.js — session persistence for acuros.ca
 *
 * ── Why this is now dead simple ────────────────────────────────────────────
 * Every Acuros app page (patient-portal, editor, developer console, dashboard,
 * onboarding, bookings, settings, shop) is served from ONE origin:
 * https://www.acuros.ca. The developer console is www.acuros.ca/developer —
 * there is no live dev.acuros.ca (no DNS record). So there is nothing to share
 * a session ACROSS: plain, per-origin localStorage — supabase-js's default,
 * battle-tested storage — is all that's needed and Just Works.
 *
 * The previous version mirrored the session into a chunked `.acuros.ca` cookie
 * to reach a dev.acuros.ca that no longer exists. That machinery (chunking +
 * localStorage⇄cookie reconciliation + "newest wins" dedup) was the single
 * biggest source of sign-in bugs: a stale or half-written cookie could shadow
 * the good localStorage session and hand Supabase a revoked refresh token, so
 * getSession() returned null and owner pages looped on "sign in" forever — a
 * loop that re-signing-in could not clear because the bad cookie survived.
 *
 * This version:
 *   • Uses supabase-js's DEFAULT localStorage storage (no custom storage).
 *   • Keeps UI flags (role/initial) in localStorage only.
 *   • On load, ONE-TIME deletes any legacy session/flag COOKIES so a corrupt
 *     leftover cookie from the old scheme can never interfere again.
 *   • Preserves the exact public API (window.createAcurosClient, window.acurosAuth)
 *     every page already calls, so no page markup changes are required.
 */
(function () {
  var STORAGE_KEY = (window.ACUROS && window.ACUROS.STORAGE_KEY) || null;

  // ── One-time cleanup: purge legacy cookies from the old cross-subdomain
  //    scheme. We NEVER read cookies anymore, but deleting them removes any
  //    corrupt leftover that used to poison sign-in. localStorage (the real
  //    session) is untouched. Covers the .acuros.ca cookie AND a host-only one,
  //    plus the chunked variants (key, key.chunks, key.0..key.N) and flags.
  (function purgeLegacyCookies() {
    try {
      var host = location.hostname || '';
      var onAcuros = /(^|\.)acuros\.ca$/i.test(host);
      var secure = location.protocol === 'https:' ? '; secure' : '';
      function kill(name) {
        // host-only
        document.cookie = name + '=; path=/; max-age=0' + secure + '; samesite=lax';
        // .acuros.ca domain-scoped
        if (onAcuros) document.cookie = name + '=; domain=.acuros.ca; path=/; max-age=0' + secure + '; samesite=lax';
      }
      var names = [];
      if (STORAGE_KEY) {
        names.push(STORAGE_KEY, STORAGE_KEY + '.chunks');
        for (var i = 0; i < 12; i++) names.push(STORAGE_KEY + '.' + i);
      }
      names.push('ah-user-role', 'ah-user-initial');
      names.forEach(kill);
    } catch (_e) {}
  })();

  function lsGet(key) { try { return localStorage.getItem(key); } catch (_e) { return null; } }
  function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (_e) {} }
  function lsRemove(key) { try { localStorage.removeItem(key); } catch (_e) {} }

  // Absolute expiry (unix seconds) of the stored session, or -1 if unparseable.
  function sessionExpiry(raw) {
    if (!raw) return -1;
    try {
      var o = JSON.parse(raw);
      var e = o && (o.expires_at || (o.currentSession && o.currentSession.expires_at));
      return typeof e === 'number' ? e : -1;
    } catch (_e) { return -1; }
  }

  // ── UI flags (role / initial) — plain per-origin localStorage ──────────────
  function setFlag(name, value) { lsSet(name, value); }
  function getFlag(name) { return lsGet(name); }
  function clearFlag(name) { lsRemove(name); }

  // ── Public helper API (unchanged surface; localStorage-backed) ─────────────
  window.acurosAuth = {
    STORAGE_KEY: STORAGE_KEY,
    // Raw stored session JSON, or null.
    rawSession: function () { return STORAGE_KEY ? lsGet(STORAGE_KEY) : null; },
    // True when a non-expired access token is present.
    isSignedIn: function () {
      var raw = this.rawSession();
      if (!raw) return false;
      var exp = sessionExpiry(raw);
      return exp === -1 ? false : (exp * 1000 > Date.now() - 5000);
    },
    // Poison recovery. Call from an auth gate after getSession() returns null:
    // if a session is still sitting in storage it's stale/unrefreshable, so
    // purge it and the next sign-in writes clean state. Returns true if purged.
    purgeIfStale: function () {
      try {
        if (this.rawSession()) { this.clearAll(); return true; }
      } catch (_e) {}
      return false;
    },
    setRole: function (role) { if (role) setFlag('ah-user-role', role); },
    getRole: function () { return getFlag('ah-user-role'); },
    setInitial: function (i) { if (i) setFlag('ah-user-initial', i); },
    getInitial: function () { return getFlag('ah-user-initial'); },
    // Wipe every trace of the session + flags. Use on sign-out / recovery.
    clearAll: function () {
      if (STORAGE_KEY) lsRemove(STORAGE_KEY);
      clearFlag('ah-user-role');
      clearFlag('ah-user-initial');
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf('sb-') === 0 || k.indexOf('ah-') === 0) localStorage.removeItem(k);
        });
      } catch (_e) {}
    },
  };

  // Drop-in replacement for window.supabase.createClient. Uses the DEFAULT
  // storage (localStorage) — same-origin, so no cross-subdomain adapter needed.
  window.createAcurosClient = function (url, key, opts) {
    opts = opts || {};
    var auth = Object.assign({
      storageKey: STORAGE_KEY || undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }, opts.auth || {});
    return window.supabase.createClient(url, key, Object.assign({}, opts, { auth: auth }));
  };
})();
