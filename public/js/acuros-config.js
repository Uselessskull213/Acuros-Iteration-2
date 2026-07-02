/* acuros-config.js — single source of truth for the Supabase connection.
 *
 * Loaded BEFORE acuros-auth.js (and before any page instantiates a client).
 * Previously the project URL + anon JWT were copy-pasted into every page's
 * inline <script>; rotating the key or project meant editing ~9 files and a
 * missed page silently broke auth on that route. Now it lives in ONE place.
 *
 * The anon key is public by design (it only grants what RLS allows), so this
 * is not a secret — it is a maintenance/rotation convenience.
 */
(function () {
  var REF = 'pyexkdoupqzbnrybiubo';
  window.ACUROS = {
    PROJECT_REF: REF,
    SUPABASE_URL: 'https://' + REF + '.supabase.co',
    SUPABASE_ANON_KEY:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5ZXhrZG91cHF6Ym5yeWJpdWJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4Mzg4MzYsImV4cCI6MjA4NzQxNDgzNn0.3_dLQEJfmC08A2-hlgOfwlu4ngx7hslUR3Dun4BoXLU',
    // supabase-js v2 stores the session under this localStorage/cookie key.
    STORAGE_KEY: 'sb-' + REF + '-auth-token',
    // Canonical origin. All auth + post-auth redirects pin here so login
    // never resolves against dev.acuros.ca (a different origin) by accident.
    //
    // MUST be the www host: Vercel 307s acuros.ca -> www.acuros.ca, and the
    // Supabase redirect allowlist only accepts https://www.acuros.ca/* —
    // a bare-apex redirect_to gets silently replaced with the Site URL
    // (the homepage), which strands OAuth tokens on a page with no client.
    APEX_ORIGIN: 'https://www.acuros.ca',
  };
})();
