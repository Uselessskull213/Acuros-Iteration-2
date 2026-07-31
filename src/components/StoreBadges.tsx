export const APP_STORE_URL = 'https://apps.apple.com/ca/app/acuros/id6764665756';
export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.acuros.health';

export default function StoreBadges({ size = 'md' }: { size?: 'md' | 'sm' }) {
  return (
    <div className={`store-badges store-badges-${size}`}>
      <a href={APP_STORE_URL} target="_blank" rel="noopener" aria-label="Download Acuros on the App Store">
        <img src="/badges/app-store.svg" alt="Download on the App Store" />
      </a>
      <a href={GOOGLE_PLAY_URL} target="_blank" rel="noopener" aria-label="Get Acuros on Google Play">
        <img src="/badges/google-play.png" alt="Get it on Google Play" />
      </a>
    </div>
  );
}
