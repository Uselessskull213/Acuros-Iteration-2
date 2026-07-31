import Logo from './Logo';
import StoreBadges from './StoreBadges';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-grid">
        <div className="footer-brand">
          <div className="footer-logo">
            <Logo size={40} />
            <div>
              <span className="footer-word">ACUROS</span>
              <span className="footer-sub">HEALTH</span>
            </div>
          </div>
          <p>Patient engagement platform for modern clinics. Built in Canada.</p>
          <a href="mailto:info@acuros.ca">info@acuros.ca</a>
          <StoreBadges size="sm" />
        </div>
        <nav aria-label="Platform">
          <h4>Platform</h4>
          <a href="/onboarding">Set up your clinic</a>
          <a href="/ai-assistant">AI Assistant</a>
          <a href="/shop">Clinic Shop</a>
          <a href="/patient-portal" data-auth-hide>
            Patient Login
          </a>
        </nav>
        <nav aria-label="Legal">
          <h4>Legal</h4>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
        </nav>
        <div>
          <h4>Standards</h4>
          <ul className="footer-standards">
            <li>PIPEDA compliant</li>
            <li>PHIPA aligned</li>
            <li>Canadian servers</li>
            <li>AES-256 encrypted</li>
          </ul>
        </div>
      </div>
      <div className="footer-base">
        <span>© 2026 Acuros Health Inc. All rights reserved.</span>
        <span>AI tools are educational only. Not a substitute for professional medical advice.</span>
      </div>
    </footer>
  );
}
