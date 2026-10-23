// Icons (2.4, V53): one small set of inline stroke glyphs, 1.5 px lines, in place of the emoji the
// screens used before. Decorative wherever they sit next to a word (aria-hidden); a button that
// shows only an icon carries its own aria-label. The brand mark (`Logo`) is the app icon's S.

import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "users"
  | "calendar"
  | "calendarPlus"
  | "history"
  | "car"
  | "book"
  | "childcare"
  | "chat"
  | "chevron"
  | "arrow"
  | "back"
  | "menu"
  | "locate"
  | "pin"
  | "place"
  | "search"
  | "home"
  | "bell"
  | "install"
  | "check";

const GLYPHS: Record<IconName, ReactNode> = {
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15.5 14.5A5 5 0 0 1 21.5 20" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  calendarPlus: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  car: (
    <>
      <path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11" />
      <path d="M3 13.5A1.5 1.5 0 0 1 4.5 12h15a1.5 1.5 0 0 1 1.5 1.5V17H3z" />
      <circle cx="7" cy="17.5" r="1.5" />
      <circle cx="17" cy="17.5" r="1.5" />
    </>
  ),
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 19a2 2 0 0 1 2-2h13" />
    </>
  ),
  childcare: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  chat: <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  locate: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5M8 17h8M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
    </>
  ),
  place: (
    <>
      <path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11z" />
      <circle cx="12" cy="10" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  home: (
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h5v-6h4v6h5V10" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  install: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M12 7v7M9 11l3 3 3-3" />
    </>
  ),
  check: <path d="M5 12l5 5L20 7" />
};

type Props = { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">;

export function Icon({ name, size = 20, className, ...rest }: Props) {
  return (
    <svg
      className={className ? `ico ${className}` : "ico"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}

/** The catalog's configured icons (an emoji in the seed) and the ones the screens used before. */
export const EMOJI_ICONS: Readonly<Record<string, IconName>> = {
  "🚗": "car",
  "📚": "book",
  "🧸": "childcare",
  "📅": "calendar",
  "🤝": "users",
  "🕘": "history",
  "💬": "chat",
  "📍": "place",
  "🏠": "home"
};

/** The brand mark: the app icon's S (a route) with its mint dot (the destination). */
export function Logo({ size = 56, className }: { size?: number; className?: string }) {
  return (
    <div className={className ? `logo ${className}` : "logo"} aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 512 512" width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} focusable="false">
        <path d="M323.7 159.4A72 72 0 1 0 256 256A72 72 0 1 1 188.3 352.6" fill="none" stroke="currentColor" strokeWidth="44" strokeLinecap="round" />
        <circle cx="382" cy="398" r="26" className="logo-dot" />
      </svg>
    </div>
  );
}
