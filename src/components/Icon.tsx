// Icons (2.4, V53): one small set of inline stroke glyphs, 1.5 px lines, in place of the emoji the
// screens used before. Decorative wherever they sit next to a word (aria-hidden); a button that
// shows only an icon carries its own aria-label. The brand mark (`Logo`) is the app icon's S.

import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "users"
  | "image"
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
  | "check"
  // 2.8: the YOLO events, the section's sparkle, sharing an invite link
  | "pumpkin"
  | "gift"
  | "tree"
  | "fireworks"
  | "snowflake"
  | "toast"
  | "mask"
  | "egg"
  | "balloon"
  | "beach"
  | "backpack"
  | "cake"
  | "popper"
  | "moon"
  | "rings"
  | "sparkles"
  | "share"
  | "link";

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
  check: <path d="M5 12l5 5L20 7" />,
  pumpkin: (
    <>
      <path d="M12 7.5c-4.4 0-8 2.8-8 6.3S7.6 20 12 20s8-2.7 8-6.2-3.6-6.3-8-6.3z" />
      <path d="M12 7.5c-1.9 0-3 2.8-3 6.3S10.1 20 12 20s3-2.7 3-6.2-1.1-6.3-3-6.3z" />
      <path d="M12 7.5V5a2 2 0 0 1 2-2" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="1.5" />
      <path d="M3 9h18M12 9v11" />
      <path d="M12 9C10.5 6 7 5 7 7.3S10 9 12 9zM12 9c1.5-3 5-4 5-1.7S14 9 12 9z" />
    </>
  ),
  tree: (
    <>
      <path d="M12 3L7 9h3l-4 5h4l-4 5h12l-4-5h4l-4-5h3z" />
      <path d="M12 19v2.5" />
    </>
  ),
  fireworks: (
    <>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  snowflake: (
    <>
      <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />
      <path d="M10 4.5l2 1.5 2-1.5M10 19.5l2-1.5 2 1.5" />
    </>
  ),
  toast: (
    <>
      <path d="M4.5 3H10l-.6 4.2a2.2 2.2 0 0 1-4.3 0z" />
      <path d="M7.25 9.4V18M5 18h4.5" />
      <path d="M14 3h5.5l-.6 4.2a2.2 2.2 0 0 1-4.3 0z" />
      <path d="M16.75 9.4V18M14.5 18H19" />
    </>
  ),
  mask: (
    <>
      <path d="M3 8c3-1.5 6-1.5 9 0 3-1.5 6-1.5 9 0 0 5-3 8-6 8-1.7 0-2.4-1.5-3-3-.6 1.5-1.3 3-3 3-3 0-6-3-6-8z" />
      <path d="M7 11.5h2M15 11.5h2" />
    </>
  ),
  egg: (
    <>
      <path d="M12 3c-3.5 0-6.5 5.5-6.5 10a6.5 6.5 0 0 0 13 0C18.5 8.5 15.5 3 12 3z" />
      <path d="M6 12.5l2.5-1.5 2 1.5 2-1.5 2 1.5 2-1.5 1.5 1" />
    </>
  ),
  balloon: (
    <>
      <path d="M12 3a5.5 5.5 0 0 0-5.5 5.5C6.5 12 9.5 15 12 15s5.5-3 5.5-6.5A5.5 5.5 0 0 0 12 3z" />
      <path d="M11 15l1 1.5 1-1.5" />
      <path d="M12 16.5c-1 1.5 1 2.5 0 4.5" />
    </>
  ),
  beach: (
    <>
      <path d="M3 11a9 9 0 0 1 18 0z" />
      <path d="M12 11v8a2 2 0 0 1-2 2" />
      <path d="M14.5 21H21" />
    </>
  ),
  backpack: (
    <>
      <path d="M6 10a6 6 0 0 1 12 0v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" />
      <path d="M9 4.5V4a3 3 0 0 1 6 0v.5" />
      <rect x="9" y="13" width="6" height="4" rx="1" />
    </>
  ),
  cake: (
    <>
      <path d="M4 20h16" />
      <rect x="5" y="12" width="14" height="8" rx="1.5" />
      <path d="M5 15.5c1.2 1 2.3 1 3.5 0s2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0" />
      <path d="M9 12V9M12 12V9M15 12V9M9 6.5v.5M12 6.5v.5M15 6.5v.5" />
    </>
  ),
  popper: (
    <>
      <path d="M4 20l4.5-12 7.5 7.5z" />
      <path d="M14 4v2M19 9h2M17.5 5.5L19 4M13 9.5c1.5-1.5 3.5-1.5 4.5-.5" />
    </>
  ),
  moon: (
    <>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
      <path d="M16 3.5v2M15 4.5h2" />
    </>
  ),
  rings: (
    <>
      <circle cx="9" cy="14.5" r="5" />
      <circle cx="15" cy="14.5" r="5" />
      <path d="M7.5 6.5L9 4.5l1.5 2L9 8.5z" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8z" />
      <path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V3M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M21 16l-5-5-7 7M3 17l4-4 3 3" />
    </>
  )
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
  "🏠": "home",
  // 2.8: the YOLO events
  "🎃": "pumpkin",
  "🎁": "gift",
  "🎄": "tree",
  "🎆": "fireworks",
  "❄️": "snowflake",
  "💝": "toast",
  "🎭": "mask",
  "🥚": "egg",
  "🎈": "balloon",
  "🏖️": "beach",
  "🎒": "backpack",
  "🎂": "cake",
  "🎉": "popper",
  "🌙": "moon",
  "💍": "rings"
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
