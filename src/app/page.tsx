import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import Hero from '@/components/Hero';
import Footer from '@/components/Footer';
import ContactForm from '@/components/ContactForm';
import BenefitsTabs from '@/components/BenefitsTabs';
import Logo from '@/components/Logo';
import Chip from '@/components/Chip';
import { Reveal, Tilt, Parallax, Medallion } from '@/components/fx';

const FAQS = [
  {
    q: 'What is Acuros Health?',
    a: 'Acuros Health is a patient engagement platform for Canadian clinics. It gives each clinic a branded, white-labelled patient portal - with an AI health assistant, online bookings, loyalty rewards, a clinic-curated shop, and PIPEDA-compliant records - live at acuros.ca/c/your-slug with no EMR migration.',
  },
  {
    q: 'How long does it take to set up a clinic portal?',
    a: 'A clinic portal goes live in a day. Setup starts with a 20-minute guided onboarding call; the AI then structures your services and brand copy and publishes your portal. There is no EMR migration, no setup fee, and no IT overhead.',
  },
  {
    q: 'Is Acuros compliant with Canadian privacy law?',
    a: 'Yes. Patient records are stored with PIPEDA-compliant, AES-256 encryption on Canadian servers, and the platform is PHIPA-aligned. AI session history is stored locally and never shared.',
  },
  {
    q: 'What do patients get in the portal?',
    a: 'Patients use one secure portal to ask health questions 24/7, prepare for appointments with AI-generated briefs, book procedures directly (confirmed within one business day), earn loyalty points redeemable for clinic credits, and access products curated by their clinic.',
  },
  {
    q: 'Does the AI assistant replace medical advice?',
    a: 'No. The assistant is powered by Claude and provides evidence-based health education - lab interpretation, diagnosis clarity, and appointment preparation. It is educational only and not a substitute for professional medical advice.',
  },
  {
    q: 'Do patients need to install an app?',
    a: 'No install is needed. Each clinic portal is a website at acuros.ca/c/your-slug, accessible from any browser. Guests get one free AI message; patients get full access after signing in.',
  },
];

const TITLE = 'Acuros Health | Branded patient portals for Canadian clinics';
const DESC =
  'Give your clinic a branded patient portal with an AI health assistant, online bookings, loyalty rewards, and PIPEDA-compliant records. Built for Canadian clinics. Live in a day, no EMR migration.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  keywords:
    'patient portal, clinic software, branded patient portal, AI health assistant, clinic loyalty program, PIPEDA patient records, online bookings clinic, healthcare platform Canada, clinic management, white-label patient portal',
  alternates: {
    canonical: 'https://acuros.ca/',
    languages: { 'en-ca': 'https://acuros.ca/', 'x-default': 'https://acuros.ca/' },
  },
  openGraph: {
    type: 'website',
    url: 'https://acuros.ca/',
    title: TITLE,
    description:
      'Give your clinic a branded patient portal with an AI health assistant, online bookings, loyalty rewards, and PIPEDA-compliant records. Live in a day, no EMR migration.',
    siteName: 'Acuros Health',
    locale: 'en_CA',
    images: [
      {
        url: 'https://acuros.ca/hero-bg.jpg',
        width: 1400,
        height: 900,
        alt: 'Acuros Health - patient engagement platform for Canadian clinics',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description:
      'Give your clinic a branded patient portal with an AI health assistant, online bookings, loyalty rewards, and PIPEDA-compliant records.',
    images: ['https://acuros.ca/hero-bg.jpg'],
  },
};

const ORG = {
  '@type': 'Organization',
  '@id': 'https://acuros.ca/#org',
  name: 'Acuros Health',
  url: 'https://acuros.ca/',
  logo: 'https://acuros.ca/favicon-512.png',
  email: 'info@acuros.ca',
  areaServed: 'CA',
  description:
    'Patient engagement platform for Canadian clinics. Branded portals with an AI health assistant, online bookings, loyalty rewards, and PIPEDA-compliant records.',
};

const JSONLD = {
  '@context': 'https://schema.org',
  '@graph': [
    ORG,
    {
      '@type': 'WebSite',
      '@id': 'https://acuros.ca/#website',
      url: 'https://acuros.ca/',
      name: 'Acuros Health',
      publisher: { '@id': 'https://acuros.ca/#org' },
      inLanguage: 'en-CA',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Acuros Health',
      applicationCategory: 'HealthApplication',
      operatingSystem: 'Web, iOS, Android',
      offers: { '@type': 'Offer', price: 0, priceCurrency: 'CAD', availability: 'https://schema.org/InStock' },
      publisher: { '@id': 'https://acuros.ca/#org' },
      description:
        'Branded patient portal for clinics. AI health assistant, online bookings, loyalty rewards, and PIPEDA-compliant records.',
      url: 'https://acuros.ca/',
    },
    {
      '@type': 'WebPage',
      url: 'https://acuros.ca/',
      name: TITLE,
      isPartOf: { '@id': 'https://acuros.ca/#website' },
      about: { '@id': 'https://acuros.ca/#org' },
      primaryImageOfPage: 'https://acuros.ca/hero-bg.jpg',
      inLanguage: 'en-CA',
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ],
};

export default function Home() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSONLD) }} />
      <Nav />
      <main>
        <Hero />

        {/* ── Split panels: clinics / patients ── */}
        <section className="split">
          <a className="split-panel" href="/onboarding">
            <div
              className="split-bg"
              style={{
                backgroundImage:
                  'url(https://images.unsplash.com/photo-1519682337058-a94d519337bc?w=1200&q=80&auto=format&fit=crop)',
              }}
            />
            <div className="split-scrim" />
            <div className="split-body">
              <h2>
                Strengthen every <em>patient relationship.</em>
              </h2>
              <p>
                Tell our AI about your clinic in six questions. Your branded patient portal goes live at
                acuros.ca/c/your-slug. No EMR migration, no setup fee.
              </p>
              <span className="split-cta">Set up your clinic →</span>
            </div>
          </a>
          <a className="split-panel" href="/patient-portal">
            <div
              className="split-bg"
              style={{
                backgroundImage:
                  'url(https://images.unsplash.com/photo-1505751172876-fa1923c5c528?w=1200&q=80&auto=format&fit=crop)',
              }}
            />
            <div className="split-scrim" />
            <div className="split-body">
              <h2>
                Your health, <em>at your fingertips.</em>
              </h2>
              <p>
                Ask health questions, prepare for appointments, earn loyalty rewards, and access clinic-curated
                products - all in one secure portal.
              </p>
              <span className="split-cta">Patient Login →</span>
            </div>
          </a>
        </section>

        {/* ── Three tools, asymmetric editorial grid ── */}
        <section className="section tools">
          <Reveal variant="fade">
            <span className="eyebrow">The platform</span>
          </Reveal>
          <Reveal as="h2" className="sec-title">
            Three tools. <em>One platform.</em>
          </Reveal>
          <div className="tools-grid">
            <Reveal className="tool tool-tall" variant="left">
              <Tilt className="bezel tool-bezel" max={5} lift={-3}>
                <a className="tool-card" href="/ai-assistant">
                  <figure
                    style={{
                      backgroundImage:
                        'url(https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=1100&q=80&auto=format&fit=crop)',
                    }}
                  />
                  <div className="tool-body">
                    <h3>
                      Evidence-based <em>answers.</em>
                    </h3>
                    <p>Lab interpretation, diagnosis clarity, and appointment prep, 24/7, powered by Claude.</p>
                    <span className="tool-cta">Try it free →</span>
                  </div>
                </a>
              </Tilt>
            </Reveal>
            <Reveal className="tool" variant="right" delay={90}>
              <Tilt className="bezel tool-bezel" max={5} lift={-3}>
                <a className="tool-card" href="#contact">
                  <figure
                    style={{
                      backgroundImage:
                        'url(https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=1100&q=80&auto=format&fit=crop)',
                    }}
                  />
                  <div className="tool-body">
                    <h3>
                      Retention <em>by design.</em>
                    </h3>
                    <p>
                      Patients earn points for activity, check-ins, and referrals, redeemable for clinic credits.
                      Engagement that compounds.
                    </p>
                    <span className="tool-cta">See how it works →</span>
                  </div>
                </a>
              </Tilt>
            </Reveal>
            <Reveal className="tool" variant="right" delay={180}>
              <Tilt className="bezel tool-bezel" max={5} lift={-3}>
                <a className="tool-card" href="/patient-portal">
                  <figure
                    style={{
                      backgroundImage:
                        'url(https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=1100&q=80&auto=format&fit=crop)',
                    }}
                  />
                  <div className="tool-body">
                    <h3>
                      Your clinic, <em>branded.</em>
                    </h3>
                    <p>Records, bookings, shop, and AI in one white-labelled portal, same day, no EMR migration.</p>
                    <span className="tool-cta">Patient login →</span>
                  </div>
                </a>
              </Tilt>
            </Reveal>
          </div>
        </section>

        <Medallion />

        {/* ── Benefits, tabbed ── */}
        <section className="section">
          <Reveal variant="fade">
            <span className="eyebrow">Benefits</span>
          </Reveal>
          <Reveal as="h2" className="sec-title">
            Everything your clinic <em>needs, nothing it doesn&rsquo;t.</em>
          </Reveal>
          <Reveal delay={120}>
            <BenefitsTabs />
          </Reveal>
        </section>

        {/* ── How it works ── */}
        <section className="section how">
          <Reveal variant="fade">
            <span className="eyebrow">Onboarding</span>
          </Reveal>
          <div className="how-head">
            <Reveal as="h2" className="sec-title" variant="left">
              Live in a day. <em>No disruption.</em>
            </Reveal>
            <Reveal variant="right">
              <a className="btn btn-outline" href="#contact">
                Schedule a walkthrough
              </a>
            </Reveal>
          </div>
          <ol className="how-steps">
            <Reveal as="li" delay={0}>
              <span className="how-n">01</span>
              <h3>Onboarding call</h3>
              <p>
                A 20-minute guided session with our team. We configure your clinic code, branding, product catalogue,
                and feature set - no technical effort on your side.
              </p>
            </Reveal>
            <Reveal as="li" delay={110}>
              <span className="how-n">02</span>
              <h3>Portal goes live</h3>
              <p>
                The wizard structures your services, polishes your brand copy, and publishes your portal at
                acuros.ca/c/your-slug. Patients access it without an app install.
              </p>
            </Reveal>
            <Reveal as="li" delay={220}>
              <span className="how-n">03</span>
              <h3>Patients stay engaged</h3>
              <p>
                AI guidance, loyalty rewards, and clinic-curated products keep your patients connected and returning
                between every visit.
              </p>
            </Reveal>
          </ol>
        </section>

        {/* ── AI spotlight ── */}
        <section className="section ai">
          <div className="ai-grid">
            <div className="ai-copy">
              <Reveal variant="fade">
                <span className="eyebrow">Acuros AI</span>
              </Reveal>
              <Reveal as="h2" className="sec-title" variant="left">
                Ask anything <em>about your health.</em>
              </Reveal>
              <Reveal as="p" className="ai-lead" variant="left" delay={90}>
                Evidence-based health guidance available 24/7. From interpreting lab results to understanding a
                diagnosis - your AI health partner is always ready.
              </Reveal>
              <Reveal className="ai-ctas" variant="left" delay={160}>
                <a className="btn btn-solid" href="/ai-assistant">
                  Try the AI Assistant
                  <Chip />
                </a>
                <a className="btn btn-outline" href="/patient-portal" data-auth-hide>
                  Patient Login
                </a>
              </Reveal>
              <Reveal as="div" variant="left" delay={230}>
                <ul className="ai-points">
                  <li>Powered by Claude - evidence-based, not generic</li>
                  <li>1 free message for guests - full access for patients</li>
                  <li>Session history stored locally - never shared</li>
                </ul>
              </Reveal>
            </div>
            <Reveal variant="right" delay={120}>
              <Tilt className="bezel chat-bezel" max={6} lift={-2}>
                <div className="chat-card">
                <div className="chat-head">
                  <Logo size={20} />
                  <span>Acuros AI</span>
                  <span className="chat-live" aria-hidden="true" />
                </div>
                <div className="chat-q">What does my ferritin level of 12 ng/mL mean?</div>
                <div className="chat-a">
                  A ferritin of 12 ng/mL is at the low end of the normal range and may indicate early iron depletion.
                  Your doctor may recommend dietary adjustments or supplementation.
                </div>
                <div className="chat-q">Can you help me prepare questions for my checkup?</div>
                <div className="chat-a">
                  Absolutely. Based on your profile, here are three questions worth discussing with your care team -
                  tailored to your current health record.
                </div>
                <div className="chat-typing">
                  <span />
                  <span />
                  <span />
                  AI is typing…
                </div>
                </div>
              </Tilt>
            </Reveal>
          </div>
        </section>

        {/* ── FAQ — extractable answers, no accordions ── */}
        <section className="section" id="faq">
          <Reveal variant="fade">
            <span className="eyebrow">Common questions</span>
          </Reveal>
          <Reveal as="h2" className="sec-title">
            Answers, <em>before you ask.</em>
          </Reveal>
          <Reveal as="p" className="faq-lead" delay={80}>
            {FAQS[0].a}
          </Reveal>
          <div className="faq-grid">
            {FAQS.slice(1).map((f, i) => (
              <Reveal as="div" key={f.q} delay={i * 60}>
                <article className="faq-item">
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── CTA banner with parallax watermark ── */}
        <section className="banner">
          <Parallax speed={0.14} className="banner-mark" aria-hidden>
            <Logo size={560} />
          </Parallax>
          <Reveal as="h2" className="banner-title">
            The patient portal your clinic <em>deserves.</em>
          </Reveal>
          <Reveal className="banner-ctas" delay={120}>
            <a className="btn btn-solid btn-lg" href="/onboarding">
              Set up your clinic
              <Chip />
            </a>
            <a className="btn btn-glass btn-lg" href="/patient-portal" data-auth-hide>
              Patient Login
            </a>
          </Reveal>
        </section>

        {/* ── Contact ── */}
        <section className="contact" id="contact">
          <div className="contact-info">
            <Reveal variant="fade">
              <span className="eyebrow">Contact</span>
            </Reveal>
            <Reveal as="h2" variant="left">
              Let&rsquo;s set up your clinic.
            </Reveal>
            <Reveal as="p" variant="left" delay={80}>
              Our team will walk you through the platform and configure your clinic from day one - no commitment
              required.
            </Reveal>
            <Reveal variant="left" delay={150}>
              <ul>
                <li>20-minute guided demo - no commitment required</li>
                <li>Self-serve onboarding. AI structures your portal in minutes.</li>
                <li>Dedicated support through your first launch week</li>
              </ul>
            </Reveal>
            <Reveal as="p" className="contact-note" variant="left" delay={210}>
              Now in early access. Built for Canadian clinics.
            </Reveal>
            <Reveal className="contact-tags" variant="left" delay={260}>
              <span>PIPEDA</span>
              <span>PHIPA</span>
              <span>HL7 / FHIR</span>
            </Reveal>
          </div>
          <Reveal className="contact-form-wrap" variant="right" delay={100}>
            <ContactForm />
          </Reveal>
        </section>
      </main>
      <Footer />
    </>
  );
}
