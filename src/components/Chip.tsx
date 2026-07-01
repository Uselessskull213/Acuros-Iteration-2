// Trailing arrow chip for primary CTAs — the arrow never sits naked.
export default function Chip() {
  return (
    <span className="btn-chip" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2.5 9.5 9.5 2.5M4 2.5h5.5V8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
