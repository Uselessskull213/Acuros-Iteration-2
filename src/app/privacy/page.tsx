import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import './privacy.css';

const TITLE = 'Privacy Policy - Acuros Health';
const DESC =
  'Privacy policy for Acuros Health - PIPEDA-compliant. Learn how we collect, use, store, and protect patient health data on the Acuros platform.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: {
    canonical: 'https://acuros.ca/privacy',
    languages: { 'en-ca': 'https://acuros.ca/privacy' },
  },
  openGraph: {
    type: 'website',
    url: 'https://acuros.ca/privacy',
    title: 'Privacy Policy | Acuros Health',
    description: 'PIPEDA-compliant privacy policy for Acuros Health.',
    siteName: 'Acuros Health',
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary',
    title: 'Privacy Policy | Acuros Health',
    description: 'PIPEDA-compliant privacy policy for Acuros Health.',
  },
};

export default function PrivacyPage() {
  return (
    <div className="legal-page">
      <Nav />
      <main className="legal-main" id="main">
        <div className="legal-wrap">
          <header className="legal-hero">
            <p className="legal-kicker">Legal</p>
            <h1 className="legal-title">
              Privacy <em>Policy</em>
            </h1>
            <p className="legal-dates">Effective Date: January 28, 2026 · Last Updated: January 28, 2026</p>
          </header>

          <div className="legal-intro">
            <p>
              Acuros Health (&ldquo;Acuros,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is
              committed to protecting privacy and handling personal information responsibly. This Privacy Policy
              explains how we collect, use, store, and protect information when you visit acuros.ca or interact with
              our services.
            </p>
            <p>We design our systems with privacy, security, and data minimization as core principles.</p>
          </div>

          <section className="legal-section">
            <h2>
              <span className="legal-no">1.</span>Information We Collect
            </h2>
            <p>
              <strong>1.1 Information You Provide</strong>
              <br />
              We may collect information you voluntarily provide, including name, email address, organization or
              affiliation, contact details, and information submitted through contact forms or demo requests. We do
              not require unnecessary personal data to access general site content.
            </p>
            <p>
              <strong>1.2 Automatically Collected Information</strong>
              <br />
              When you visit our website, we may collect limited technical data, such as IP address, browser type,
              device information, and pages visited. This data is used solely for security, analytics, and performance
              improvement.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">2.</span>How We Use Information
            </h2>
            <p>
              We use collected information to respond to inquiries and demo requests, communicate about our services,
              improve website functionality and performance, maintain security and prevent misuse, and comply with
              legal and regulatory obligations. We do not sell personal information.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">3.</span>Healthcare and Sensitive Data
            </h2>
            <p>
              Acuros does not collect personal health information (PHI) through its public website. Any
              healthcare-related data processed through Acuros platforms is governed by separate agreements and
              handled in accordance with applicable healthcare privacy laws.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">4.</span>Data Sharing and Disclosure
            </h2>
            <p>
              We may share information only with trusted service providers under strict confidentiality obligations,
              when required by law or legal process, or to protect the rights, safety, or security of Acuros and its
              users. We do not share data for advertising purposes.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">5.</span>Data Security
            </h2>
            <p>
              We implement administrative, technical, and organizational safeguards designed to protect information
              against unauthorized access, alteration, or disclosure. While no system can guarantee absolute security,
              we prioritize healthcare-grade security practices.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">6.</span>Data Retention
            </h2>
            <p>
              We retain personal information only for as long as necessary to fulfill its purpose, unless a longer
              retention period is required by law.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">7.</span>Your Rights
            </h2>
            <p>
              Depending on your jurisdiction, you may have the right to access your personal information, request
              correction or deletion, and withdraw consent where applicable. Requests may be submitted through our
              contact page.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">8.</span>Third-Party Links
            </h2>
            <p>
              Our website may contain links to third-party sites. We are not responsible for the privacy practices of
              external websites.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">9.</span>Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy periodically. Updates will be posted on this page with a revised
              effective date.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">10.</span>Contact
            </h2>
            <p>
              For privacy-related questions, contact: <strong>info@acuros.ca</strong>
              <br />
              Website:{' '}
              <a href="https://acuros.ca" className="legal-link">
                acuros.ca
              </a>
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
