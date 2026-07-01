import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import './terms.css';

const TITLE = 'Terms of Service - Acuros Health';
const DESC =
  'Terms of service for Acuros Health. Understand the terms governing patient and clinic-owner use of the Acuros platform.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: {
    canonical: 'https://acuros.ca/terms',
    languages: { 'en-ca': 'https://acuros.ca/terms' },
  },
  openGraph: {
    type: 'website',
    url: 'https://acuros.ca/terms',
    title: 'Terms of Service | Acuros Health',
    description: 'Terms governing use of the Acuros Health platform.',
    locale: 'en_CA',
    siteName: 'Acuros Health',
  },
  twitter: {
    card: 'summary',
    title: 'Terms of Service | Acuros Health',
    description: 'Terms governing use of the Acuros Health platform.',
  },
};

export default function TermsPage() {
  return (
    <div className="legal-page">
      <Nav />
      <main className="legal-main terms-article" id="main">
        <p className="terms-kicker">Legal</p>
        <h1 className="legal-h1">Terms of Service</h1>
        <p className="terms-date">Effective Date: February 12, 2026 &middot; Last Updated: February 12, 2026</p>

        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of the website located at{' '}
          <a href="https://www.acuros.ca/">https://www.acuros.ca/</a> and all related services, features, and content,
          including Acuros AI (collectively, the &quot;Services&quot;). The Services are operated by Acuros Health Inc.
          (&quot;Acuros&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;). By accessing or using the Services,
          you agree to be legally bound by these Terms. If you do not agree, you must not use the Services.
        </p>

        <section className="legal-section">
          <h2>
            <em>1.</em> Eligibility
          </h2>
          <p>
            You must be at least the age of majority in your jurisdiction to use the Services. By using the Services,
            you represent and warrant that you meet this requirement.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>2.</em> Description of Services
          </h2>
          <p>
            Acuros provides digital health education tools and AI-generated informational content. Acuros AI is
            designed to provide general educational information about medical conditions, treatments, and healthcare
            concepts. The Services:
          </p>
          <ul>
            <li>Do not provide medical advice</li>
            <li>Do not provide identification or labeling of conditions</li>
            <li>Do not recommend specific treatments</li>
            <li>Do not replace licensed healthcare professionals</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>
            <em>3.</em> No Medical Advice and No Professional Relationship
          </h2>
          <p>
            The content provided through the Services, including AI-generated content, is not medical advice and is for
            general health education only. Use of the Services does not create a doctor-patient relationship, a
            healthcare provider relationship, a fiduciary relationship, or any licensed professional relationship. You
            should always seek the advice of a qualified healthcare provider regarding medical concerns. If you believe
            you are experiencing a medical emergency, contact emergency services immediately.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>4.</em> Artificial Intelligence Disclosure
          </h2>
          <p>
            Acuros AI uses advanced artificial intelligence systems, including third-party large language model
            providers, to generate responses. You acknowledge and agree that AI-generated content may be inaccurate,
            incomplete, outdated, or incorrect; outputs are probabilistic and generated automatically; Acuros does not
            guarantee the accuracy, completeness, or reliability of AI outputs; and you are solely responsible for how
            you interpret or use generated information.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>5.</em> Acceptable Use
          </h2>
          <p>
            You agree not to use the Services as a source of specific medical or treatment advice in place of a
            qualified professional, rely on the Services as a substitute for professional care, submit highly sensitive
            personal health information, attempt to reverse engineer or exploit the AI system, or use the Services for
            unlawful, fraudulent, or harmful purposes. Acuros may suspend or terminate access for violations of these
            Terms.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>6.</em> User Content
          </h2>
          <p>
            If you submit content, including prompts or messages, you retain ownership of your content. You grant
            Acuros a limited, non-exclusive, royalty-free license to process and use such content to provide and
            improve the Services. You are responsible for ensuring that submitted content does not violate applicable
            laws or third-party rights.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>7.</em> Intellectual Property
          </h2>
          <p>
            All content, software, design elements, trademarks, logos, branding, and technology associated with the
            Services are the property of Acuros Health Inc. or its licensors. You may not copy, reproduce, distribute,
            modify, or create derivative works without prior written consent. &quot;Acuros&quot; and &quot;Acuros
            AI&quot; are proprietary marks of Acuros Health Inc.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>8.</em> Disclaimers
          </h2>
          <p>
            The Services are provided on an &quot;as is&quot; and &quot;as available&quot; basis. To the fullest extent
            permitted by law, Acuros disclaims all warranties, including implied warranties of merchantability, fitness
            for a particular purpose, non-infringement, and accuracy or reliability.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>9.</em> Limitation of Liability
          </h2>
          <p>
            To the maximum extent permitted by applicable law, Acuros Health Inc., its officers, directors, employees,
            and affiliates shall not be liable for indirect, incidental, special, consequential, or punitive damages;
            loss of data, profits, goodwill, or business interruption; reliance on AI-generated content; or decisions
            made based on information provided by the Services. In no event shall Acuros&apos; total liability exceed
            the greater of one hundred Canadian dollars (CAD $100), or the amount paid by you to Acuros in the
            preceding 12 months.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>10.</em> Indemnification
          </h2>
          <p>
            You agree to indemnify and hold harmless Acuros Health Inc. and its affiliates from any claims, damages,
            liabilities, or expenses arising from your misuse of the Services, violation of these Terms, reliance on
            AI-generated content, or violation of applicable laws.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>11.</em> Privacy
          </h2>
          <p>
            Your use of the Services is also governed by our <a href="/privacy">Privacy Policy</a>, which describes how
            information is collected and processed.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>12.</em> Changes to These Terms
          </h2>
          <p>
            We may update these Terms periodically. Updated versions will be posted on this page with a revised
            effective date. Continued use of the Services constitutes acceptance of the revised Terms.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>13.</em> Governing Law
          </h2>
          <p>
            These Terms are governed by the laws of the Province of Ontario and the federal laws of Canada applicable
            therein. Any disputes shall be subject to the exclusive jurisdiction of the courts of Ontario, Canada.
          </p>
        </section>

        <section className="legal-section">
          <h2>
            <em>14.</em> Contact Information
          </h2>
          <p>
            For questions regarding these Terms:
            <br />
            <strong>Acuros Health Inc.</strong>
            <br />
            Website: <a href="https://www.acuros.ca/">acuros.ca</a>
            <br />
            Email: <strong>info@acuros.ca</strong>
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
