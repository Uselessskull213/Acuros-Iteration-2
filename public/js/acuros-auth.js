/* acuros-auth.js — shared Supabase session storage for *.acuros.ca
 *
 * Why this exists: the developer console lives on dev.acuros.ca, a different
 * ORIGIN from acuros.ca. Browsers don't share localStorage across origins, so
 * a user signed in on acuros.ca would land on dev.acuros.ca signed out. This
 * adapter makes the Supabase session a cookie scoped to `.acuros.ca`, which IS
 * shared across acuros.ca, www.acuros.ca and dev.acuros.ca.
 *
 * Design — dual write (localStorage + cookie):
 *   • setItem writes BOTH localStorage and the cookie. localStorage keeps every
 *     existing acuros.ca code path working unchanged (the marketing pages and
 *     shop checkout read the sb-…-auth-token localStorage key directly), so this
 *     is purely additive on the main origin and cannot regress same-origin auth.
 *   • The cookie (scoped to .acuros.ca) is what dev.acuros.ca reads, since its
 *     localStorage is empty.
 *   • getItem prefers localStorage, falls back to the cookie (the dev.acuros.ca
 *     case). removeItem (sign-out) clears both.
 *
 * Off acuros.ca (localhost, *.vercel.app previews) it writes a host-only cookie
 * instead of a .acuros.ca cookie, so dev/preview still persist sessions — just
 * not cross-subdomain (which only matters on the real domain anyway).
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

  var storage = {
    getItem: function (key) {
      try { var ls = localStorage.getItem(key); if (ls !== null) return ls; } catch (_e) {}
      return getCookieChunked(key);
    },
    setItem: function (key, value) {
      try { localStorage.setItem(key, value); } catch (_e) {}
      try { setCookieChunked(key, value); } catch (_e) {}
    },
    removeItem: function (key) {
      try { localStorage.removeItem(key); } catch (_e) {}
      try { removeCookieChunked(key); } catch (_e) {}
    }
  };

  // Drop-in replacement for window.supabase.createClient that shares the
  // session across *.acuros.ca. Same default auth behaviour otherwise.
  window.createAcurosClient = function (url, key, opts) {
    opts = opts || {};
    var auth = Object.assign({
      storage: storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }, opts.auth || {});
    return window.supabase.createClient(url, key, Object.assign({}, opts, { auth: auth }));
  };
})();
