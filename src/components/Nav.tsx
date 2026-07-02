'use client';

import { useEffect, useRef, useState } from 'react';
import Logo from './Logo';
import Chip from './Chip';

declare global {
  interface Window {
    acurosAuth?: {
      isSignedIn(): boolean;
      getRole(): string | null;
      getInitial(): string | null;
      clearAll(): void;
    };
    ACUROS?: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string };
    supabase?: unknown;
    createAcurosClient?: (url: string, key: string) => { auth: { signOut(opts?: { scope?: string }): Promise<unknown> } };
  }
}

type AuthState = { signedIn: boolean; role: string | null; initial: string };

function readAuth(): AuthState {
  const a = typeof window !== 'undefined' ? window.acurosAuth : undefined;
  if (!a || !a.isSignedIn()) return { signedIn: false, role: null, initial: '' };
  return { signedIn: true, role: a.getRole(), initial: (a.getInitial() || 'A').charAt(0).toUpperCase() };
}

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [auth, setAuth] = useState<AuthState>({ signedIn: false, role: null, initial: '' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobOpen, setMobOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Supabase falls back to the Site URL (this homepage) when a redirect_to
    // isn't allowlisted, and magic-link emails land here by default — but no
    // Supabase client runs on this page, so tokens in the hash would be
    // silently dropped and the user left signed out. Hand them to the portal,
    // which consumes them (detectSessionInUrl) and routes by role.
    const h = window.location.hash;
    if (h.includes('access_token=') || h.includes('error_code=')) {
      window.location.replace('/patient-portal' + h);
      return;
    }
    const apply = () => {
      const a = readAuth();
      setAuth(a);
      // legacy contract: page-level "Patient Login" CTAs hide once signed in
      document.querySelectorAll<HTMLElement>('[data-auth-hide]').forEach((el) => {
        el.style.display = a.signedIn ? 'none' : '';
      });
    };
    apply();
    setDark(document.documentElement.classList.contains('dark'));
    const onStorage = () => apply();
    window.addEventListener('storage', onStorage);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const sy = window.scrollY;
        const total = document.documentElement.scrollHeight - window.innerHeight;
        setScrolled(sy > 40);
        setProgress(total > 0 ? (sy / total) * 100 : 0);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  useEffect(() => {
    document.body.style.overflow = mobOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobOpen]);

  const toggleTheme = () => {
    const isDark = document.documentElement.classList.toggle('dark');
    try {
      localStorage.setItem('ah-theme', isDark ? 'dark' : 'light');
    } catch {}
    setDark(isDark);
  };

  const signOut = async () => {
    try {
      if (window.createAcurosClient && window.ACUROS && window.supabase) {
        await window
          .createAcurosClient(window.ACUROS.SUPABASE_URL, window.ACUROS.SUPABASE_ANON_KEY)
          .auth.signOut({ scope: 'local' });
      }
    } catch {}
    try {
      window.acurosAuth?.clearAll();
    } catch {}
    window.location.href = '/';
  };

  const cta = !auth.signedIn
    ? { href: '/onboarding', label: 'Set up your clinic' }
    : auth.role === 'clinic_owner'
      ? { href: '/dashboard', label: 'Dashboard' }
      : { href: '/patient-portal', label: 'My portal' };

  const links = [
    { href: '/', label: 'Home' },
    { href: '/ai-assistant', label: 'AI Assistant' },
    ...(auth.signedIn ? [] : [{ href: '/patient-portal', label: 'Patient Login' }]),
  ];

  return (
    <>
      <div className="scroll-prog" style={{ width: `${progress}%` }} aria-hidden="true" />
      {/* mobOpen forces the cream skin so the island stays readable over the glass overlay */}
      <header className={`nav ${scrolled || mobOpen ? 'scrolled' : ''}`}>
        <a href="/" className="nav-brand" aria-label="Acuros Health — home">
          <Logo size={30} />
          <span className="nav-word">
            <span className="nav-word-main">ACUROS</span>
            <span className="nav-word-sub">HEALTH</span>
          </span>
        </a>

        <nav className="nav-links" aria-label="Primary">
          {links.map((l) => (
            <a key={l.label} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>

        <div className="nav-actions">
          <button
            type="button"
            className="nav-icon-btn"
            onClick={toggleTheme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="12" cy="12" r="4.4" />
                <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M20.4 14.2A8.4 8.4 0 0 1 9.8 3.6a8.4 8.4 0 1 0 10.6 10.6Z" />
              </svg>
            )}
          </button>

          {auth.signedIn && (
            <div className="nav-profile" ref={menuRef}>
              <button
                type="button"
                className="nav-pill"
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="Account menu"
              >
                {auth.initial}
              </button>
              {menuOpen && (
                <div className="nav-menu" role="menu">
                  <a role="menuitem" href="/settings">
                    Settings
                  </a>
                  {auth.role === 'clinic_owner' && (
                    <a role="menuitem" href="/dashboard">
                      Clinic dashboard
                    </a>
                  )}
                  <button type="button" role="menuitem" onClick={signOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="nav-cta-wrap">
            <a className="btn btn-solid" href={cta.href}>
              {cta.label}
              <Chip />
            </a>
          </div>

          <button
            type="button"
            className={`nav-burger ${mobOpen ? 'x' : ''}`}
            onClick={() => setMobOpen((o) => !o)}
            aria-label={mobOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobOpen}
          >
            <span />
            <span />
          </button>
        </div>
      </header>

      <div className={`mob-menu ${mobOpen ? 'open' : ''}`} aria-hidden={!mobOpen}>
        <nav aria-label="Mobile">
          {links.map((l) => (
            <a key={l.label} href={l.href} onClick={() => setMobOpen(false)}>
              {l.label}
            </a>
          ))}
          <a className="mob-cta" href={cta.href} onClick={() => setMobOpen(false)}>
            {cta.label}
          </a>
          {auth.signedIn && (
            <>
              <a href="/settings" onClick={() => setMobOpen(false)}>
                Settings
              </a>
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </nav>
      </div>
    </>
  );
}
