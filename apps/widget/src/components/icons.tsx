/**
 * Inline icons, so the widget ships no icon font and no extra requests.
 * All are decorative (aria-hidden); the button around them carries the label.
 */

import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
}

function Svg({ size = 20, children }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className="caddie-icon">
      {children}
    </svg>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fill="currentColor" d="M10 3l1.9 5.1L17 10l-5.1 1.9L10 17l-1.9-5.1L3 10l5.1-1.9L10 3z" />
    <path fill="currentColor" d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14zM18 2l.7 1.6L20.3 4.3l-1.6.7L18 6.6l-.7-1.6-1.6-.7 1.6-.7L18 2z" />
  </Svg>
);

/** The customer's own avatar, beside what they said. */
export const UserIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle {...stroke} cx="12" cy="8" r="3.6" />
    <path {...stroke} d="M4.8 20c0-3.5 3.2-5.6 7.2-5.6s7.2 2.1 7.2 5.6" />
  </Svg>
);

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      fill="currentColor"
      d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12Z"
    />
  </Svg>
);

export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M5 12h13M13 6l6 6-6 6" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M15 5l-7 7 7 7" />
  </Svg>
);

export const BasketIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6.2" />
    <circle cx="10" cy="20" r="1.3" fill="currentColor" />
    <circle cx="17" cy="20" r="1.3" fill="currentColor" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} strokeWidth={2.4} d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

export const ShirtIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M8 3l4 2 4-2 5 3-2.5 4-2.5-1.3V21H8V8.7L5.5 10 3 6l5-3z" />
  </Svg>
);

export const HangerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M12 8a2 2 0 1 1 2-2c0 1-1 1.4-2 2.2V9l8.4 6.3A1.5 1.5 0 0 1 19.5 18h-15a1.5 1.5 0 0 1-.9-2.7L12 9" />
  </Svg>
);

export const FlagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M6 21V3M6 4h11l-2.5 4L17 12H6" />
  </Svg>
);

export const TagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z" />
    <circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" />
  </Svg>
);

export const RulerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M3 16.5L16.5 3 21 7.5 7.5 21 3 16.5zM7 12.5l2 2M10 9.5l2 2M13 6.5l2 2" />
  </Svg>
);

export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle {...stroke} cx="12" cy="12" r="4" />
    <path {...stroke} d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const CloudIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18H7z" />
  </Svg>
);

export const WeatherMixIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M8 5V3M3.5 9.5H2M4.8 6.3 3.7 5.2M12.3 6.3l1.1-1.1" />
    <path {...stroke} d="M5 11a3 3 0 0 1 5.6-1.5" />
    <path {...stroke} d="M9 20a3.5 3.5 0 0 1-.4-7 5 5 0 0 1 9.6 1A3 3 0 0 1 18 20H9z" />
  </Svg>
);

export const PlaneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M10.5 13.5L3 11l1.5-1.5 8 .5 4-4.5a2 2 0 0 1 3 3L15 13l.5 8-1.5 1.5-2.5-7.5" />
  </Svg>
);

export const MinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M6 12h12" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M12 6v12M6 12h12" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);

export const SwapIcon = (p: IconProps) => (
  <Svg {...p}>
    <path {...stroke} d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
  </Svg>
);
