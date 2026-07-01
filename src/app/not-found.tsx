import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Logo from '@/components/Logo';

export const metadata: Metadata = {
  title: 'Page not found - Acuros Health',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="legal-page">
      <Nav />
      <main
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '8rem 1.5rem 4rem',
          gap: '1.2rem',
        }}
      >
        <Logo size={64} />
        <h1
          style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontWeight: 300,
            fontSize: 'clamp(2.4rem, 6vw, 4rem)',
            lineHeight: 1.05,
          }}
        >
          This page took <em style={{ color: 'var(--gold-ink)' }}>a sick day.</em>
        </h1>
        <p style={{ color: 'var(--sub)', maxWidth: '44ch' }}>
          The address you followed doesn&rsquo;t exist. If you were looking for your clinic&rsquo;s portal, it lives at
          acuros.ca/c/your-clinic.
        </p>
        <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <a className="btn btn-solid" href="/">
            Back to the homepage
          </a>
          <a className="btn btn-outline" href="/patient-portal">
            Patient Login
          </a>
        </div>
      </main>
      <Footer />
    </div>
  );
}
