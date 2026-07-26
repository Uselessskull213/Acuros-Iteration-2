import type { Metadata } from 'next';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import './delete-account.css';

const TITLE = 'Delete Your Account - Acuros Health';
const DESC =
  'How to delete your Acuros account and associated data — in the Acuros app or by email request. What is deleted, what is retained, and how long it takes.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: {
    canonical: 'https://acuros.ca/delete-account',
    languages: { 'en-ca': 'https://acuros.ca/delete-account' },
  },
  openGraph: {
    type: 'website',
    url: 'https://acuros.ca/delete-account',
    title: 'Delete Your Account | Acuros Health',
    description: 'How to delete your Acuros account and associated data.',
    siteName: 'Acuros Health',
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary',
    title: 'Delete Your Account | Acuros Health',
    description: 'How to delete your Acuros account and associated data.',
  },
};

export default function DeleteAccountPage() {
  return (
    <div className="legal-page">
      <Nav />
      <main className="legal-main" id="main">
        <div className="legal-wrap">
          <header className="legal-hero">
            <p className="legal-kicker">Your Data</p>
            <h1 className="legal-title">
              Delete your <em>account</em>
            </h1>
            <p className="legal-dates">Applies to the Acuros app and acuros.ca accounts · Acuros Health</p>
          </header>

          <div className="legal-intro">
            <p>
              You can permanently delete your Acuros account and the personal data associated with it at any
              time. This page explains the two ways to request deletion, exactly what is removed, what we are
              required to keep, and how long the process takes.
            </p>
          </div>

          <section className="legal-section">
            <h2>
              <span className="legal-no">1.</span>Delete from the Acuros app (fastest)
            </h2>
            <p>
              1. Open the <strong>Acuros</strong> app and sign in.
              <br />
              2. Go to <strong>Profile → Account Settings</strong>.
              <br />
              3. Choose <strong>Delete Account</strong>.
              <br />
              4. Confirm with your password. Deletion begins immediately.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">2.</span>Request deletion by email
            </h2>
            <p>
              If you can no longer access the app, email{' '}
              <a href="mailto:info@acuros.ca?subject=Delete%20my%20Acuros%20account">info@acuros.ca</a> with the
              subject line <strong>&ldquo;Delete my Acuros account&rdquo;</strong>, sent from the email address on
              your account. We verify the request and complete deletion within <strong>30 days</strong>, and we
              confirm by reply when it is done.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">3.</span>What is deleted
            </h2>
            <p>
              Deleting your account permanently removes: your login credentials and profile (name, email,
              birthday, address), your loyalty points and rewards history, your bookings and order history held
              by Acuros, and your post-treatment recovery data — including recovery cases, check-in notes, and
              face-scan photos.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">4.</span>What is retained, and for how long
            </h2>
            <p>
              Payment records are processed by Stripe and may be retained by Stripe and by us where required for
              tax, accounting, and fraud-prevention obligations (up to 7 years under Canadian law). Records a
              clinic is legally required to keep about services it provided to you are controlled by that clinic.
              Residual copies in encrypted backups are purged within <strong>90 days</strong>. Anonymized,
              aggregated statistics that can no longer identify you may be retained.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">5.</span>Deleting specific data without closing your account
            </h2>
            <p>
              You can also ask us to delete specific data — for example your recovery photos — without deleting
              your whole account. Email{' '}
              <a href="mailto:info@acuros.ca?subject=Data%20deletion%20request">info@acuros.ca</a> from your
              account email and tell us what you would like removed.
            </p>
          </section>

          <section className="legal-section">
            <h2>
              <span className="legal-no">6.</span>Questions
            </h2>
            <p>
              For anything about your data, contact <a href="mailto:info@acuros.ca">info@acuros.ca</a>. See also
              our <a href="/privacy">Privacy Policy</a>.
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
