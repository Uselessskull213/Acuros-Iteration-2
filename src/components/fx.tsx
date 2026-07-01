'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import Logo from './Logo';

const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

/* Scroll-reveal: adds .in when the element enters the viewport. */
export function Reveal({
  children,
  as: Tag = 'div',
  className = '',
  delay = 0,
  variant = 'up',
}: {
  children: ReactNode;
  as?: 'div' | 'section' | 'span' | 'li' | 'figure' | 'h2' | 'p';
  className?: string;
  delay?: number;
  variant?: 'up' | 'left' | 'right' | 'fade';
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window) || window.matchMedia(REDUCED).matches) {
      el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0, rootMargin: '0px 0px -52px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag
      // @ts-expect-error — polymorphic ref
      ref={ref}
      className={`rv rv-${variant} ${className}`}
      style={delay ? ({ transitionDelay: `${delay}ms` } as CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}

/* Pointer tilt (3D perspective) — desktop fine pointers only. */
export function Tilt({
  children,
  className = '',
  max = 8,
  lift = -4,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
  lift?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia(FINE_POINTER).matches || window.matchMedia(REDUCED).matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -max;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * max;
      el.style.transition = 'transform .14s cubic-bezier(.22,1,.36,1)';
      el.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(${lift}px)`;
    };
    const leave = () => {
      el.style.transition = 'transform .68s cubic-bezier(.34,1.56,.64,1)';
      el.style.transform = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [max, lift]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/* Scroll-linked parallax translate (rAF-throttled, transform-only). */
export function Parallax({
  children,
  speed = 0.1,
  className = '',
  rotate = 0, // extra: degrees per 1000px scrolled through the element
}: {
  children: ReactNode;
  speed?: number;
  className?: string;
  rotate?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia(REDUCED).matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2 - window.innerHeight / 2;
      const y = -mid * speed;
      const deg = rotate ? (-mid * rotate) / 1000 : 0;
      el.style.transform = `translate3d(0,${y.toFixed(1)}px,0)${deg ? ` rotate(${deg.toFixed(2)}deg)` : ''}`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [speed, rotate]);
  return (
    <div ref={ref} className={className} style={{ willChange: 'transform' }}>
      {children}
    </div>
  );
}

/* The floating 3D mark: layered SVG planes on a slow turn. Pure CSS motion. */
export function Logo3D({ size = 150, className = '' }: { size?: number; className?: string }) {
  return (
    <div className={`logo3d ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <div className="logo3d-spin">
        <Logo size={size} className="logo3d-back" color="#7a5c20" />
        <Logo size={size} className="logo3d-front" />
      </div>
    </div>
  );
}

/* Scroll-rotating gold medallion used as a section seam ornament. */
export function Medallion({ size = 56 }: { size?: number }) {
  return (
    <div className="seam" aria-hidden="true">
      <span className="seam-line" />
      <Parallax rotate={90} speed={0} className="seam-mark">
        <Logo size={size} />
      </Parallax>
      <span className="seam-line" />
    </div>
  );
}

/* Magnetic hover for CTAs (desktop only). */
export function Magnetic({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia(FINE_POINTER).matches || window.matchMedia(REDUCED).matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * 0.08;
      const dy = (e.clientY - (r.top + r.height / 2)) * 0.08;
      el.style.transform = `translate(${dx}px,${dy}px)`;
    };
    const leave = () => {
      el.style.transform = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, []);
  return (
    <div ref={ref} className={`mag ${className}`}>
      {children}
    </div>
  );
}
