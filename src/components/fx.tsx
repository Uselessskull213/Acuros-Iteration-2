'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import Logo from './Logo';

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
