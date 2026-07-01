import { useId } from 'react';

// The Acuros mark: four calligraphic petals, gold. Inline SVG so it can be
// tinted, layered and 3D-transformed without extra requests.
export default function Logo({
  size = 32,
  color,
  className,
}: {
  size?: number;
  color?: string; // flat override; omit for the gold gradient
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `g${uid}`;
  const fill = color || `url(#${gradId})`;
  return (
    <svg
      viewBox="0 0 1000 1000"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {!color && (
        <defs>
          <linearGradient id={gradId} x1="120" y1="120" x2="880" y2="880" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#D8B05A" />
            <stop offset="0.35" stopColor="#C29638" />
            <stop offset="0.65" stopColor="#B0842E" />
            <stop offset="1" stopColor="#9A7127" />
          </linearGradient>
        </defs>
      )}
      <g id={`p${uid}`}>
        <path d="M 500 58 C 368 170, 298 340, 494 480 C 396 332, 440 176, 500 58 Z" fill={fill} />
        <path d="M 500 58 C 632 170, 702 340, 506 480 C 604 332, 560 176, 500 58 Z" fill={fill} />
      </g>
      <use href={`#p${uid}`} transform="rotate(90 500 500)" />
      <use href={`#p${uid}`} transform="rotate(180 500 500)" />
      <use href={`#p${uid}`} transform="rotate(270 500 500)" />
    </svg>
  );
}
