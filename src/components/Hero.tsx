'use client';

import { useEffect, useRef, useState } from 'react';
import Chip from './Chip';

const HERO_VIDEO_DARK = '/assets/hero-dark.mp4';
const HERO_VIDEO_LIGHT = '/assets/hero-light.mp4';

/* Keeps the original hero: theme-aware looping video, mirrored + parallaxed on
 * scroll, gradient tints, staggered title entrance — plus the new floating
 * 3D gold mark hovering above the headline. */
export default function Hero() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [fired, setFired] = useState(false);

  useEffect(() => {
    const readTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setDark(isDark);
      setSrc(isDark ? HERO_VIDEO_DARK : HERO_VIDEO_LIGHT);
    };
    readTheme();
    const mo = new MutationObserver(readTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (v && src) {
      v.load();
      v.play().catch(() => {});
    }
  }, [src]);

  useEffect(() => {
    const t = setTimeout(() => setFired(true), 240);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const v = videoRef.current;
        if (v) v.style.transform = `scaleX(-1) translateY(${window.scrollY * 0.22}px)`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="hero" aria-label="Acuros Health">
      <video ref={videoRef} id="hero-video" autoPlay muted loop playsInline preload="auto" aria-hidden="true">
        {src && <source src={src} type="video/mp4" />}
      </video>
      <div className="hero-tint" style={{ background: dark ? 'rgba(0,0,0,.28)' : 'rgba(0,0,0,.14)' }} />
      <div className="hero-top" />
      <div
        className="hero-bottom"
        style={{
          background: dark
            ? 'linear-gradient(0deg,rgba(10,10,9,1) 0%,rgba(10,10,9,.72) 52%,transparent 100%)'
            : 'linear-gradient(0deg,rgba(10,10,9,1) 0%,rgba(10,10,9,.55) 50%,transparent 100%)',
        }}
      />

      <div className={`hero-inner ${fired ? 'fired' : ''}`}>
        <h1 className="hero-title">
          <span className="hl">
            <span className="hl-inner hl-1">Power Your</span>
          </span>
          <span className="hl">
            <span className="hl-inner hl-2">Practice.</span>
          </span>
        </h1>
        <div className="hero-ctas">
          <a href="/onboarding" className="btn btn-solid btn-lg">
            Set up your clinic
            <Chip />
          </a>
          <a href="/patient-portal" className="btn btn-glass btn-lg">
            Patient Login
          </a>
        </div>
      </div>
    </section>
  );
}
