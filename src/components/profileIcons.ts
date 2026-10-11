// Profile icons, chosen per master profile on the server (master_profiles.icon). Inline SVG only —
// no image assets, no brand logos. Flat fills (no gradients) so several copies on one page never
// fight over element ids.

import type { Lang } from "../core/types";

interface ProfileIconDef {
  label: Record<Lang, string>;
  /** viewBox width : height, for sizing. */
  ratio: number;
  svg: string;
}

const wheel = (cx: number) =>
  `<g transform="translate(${cx} 42.5)"><circle r="8.3" fill="#121417"/><circle r="5.5" fill="#b9bfc6"/>` +
  `<circle r="5.5" fill="none" stroke="#7d848d" stroke-width=".8"/>` +
  `<path d="M0 0L0-4.8M0 0L4.57-1.48M0 0L2.82 3.88M0 0L-2.82 3.88M0 0L-4.57-1.48" stroke="#5f666e" stroke-width="1.3" stroke-linecap="round"/>` +
  `<circle r="1.3" fill="#3b4148"/></g>`;

// Green Taycan Cross Turismo, side view facing right: shooting-brake roof with rails, black
// wheel-arch cladding, light bar at the back, four-point headlight at the front.
const TAYCAN_CT_GREEN =
  `<svg viewBox="4 12 112 43" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
  `<ellipse cx="60" cy="51.2" rx="52" ry="2.3" fill="#000" opacity=".2"/>` +
  `<path d="M11 42.5L8.6 41L8.4 34.5Q8.6 31 11 30L14.5 28Q19 22.5 24.5 20.2Q28 18.7 34 18.3L59 17.6Q64 17.5 67.5 19.6L79.5 27Q95 28 104.5 30.4Q110.5 32 111.6 35.8L111.6 39.5Q111.6 42.5 108 42.5L101.5 42.5A10.5 10.5 0 0 0 80.5 42.5L39.5 42.5A10.5 10.5 0 0 0 18.5 42.5Z" fill="#2e7d4f"/>` +
  `<path d="M8.5 37.6Q60 35.3 111.6 37.9L111.6 39.5Q111.6 42.5 108 42.5L101.5 42.5A10.5 10.5 0 0 0 80.5 42.5L39.5 42.5A10.5 10.5 0 0 0 18.5 42.5L11 42.5L8.6 41Z" fill="#22603b"/>` +
  `<path d="M12 31.8Q60 28.6 106 31.3" fill="none" stroke="#7cc896" stroke-width="1.1" opacity=".6"/>` +
  `<path d="M21.2 27.4Q23 22.6 26.5 20.9Q29 19.9 34 19.7L59 19.1Q62.5 19.1 65.2 20.7L75.6 27.6Z" fill="#1c2733"/>` +
  `<path d="M55 19.4L60.2 19.3L54.6 27.6L50.2 27.6Z" fill="#fff" opacity=".13"/>` +
  `<path d="M32.5 19.8L31.8 27.4" stroke="#2e7d4f" stroke-width="2.4"/>` +
  `<path d="M50.4 19.3L49.9 27.6" stroke="#0e1318" stroke-width="1.9"/>` +
  `<path d="M28 17.1L58.5 16.1" stroke="#15181c" stroke-width="1.5" stroke-linecap="round"/>` +
  `<path d="M30 17V18.4M56.5 16.2V17.6" stroke="#15181c" stroke-width="1.1"/>` +
  `<path d="M50.2 28.2L49.9 39M73.6 28.4Q74.4 33.5 73.8 39" stroke="#1d5233" stroke-width=".8" fill="none"/>` +
  `<rect x="42.6" y="30" width="4.2" height="1.1" rx=".55" fill="#1d5233"/>` +
  `<rect x="65.6" y="30.4" width="4.2" height="1.1" rx=".55" fill="#1d5233"/>` +
  `<path d="M74 26.6L77.6 25.9L78 27.6L74.7 28Z" fill="#22603b"/>` +
  `<path d="M101.6 30.4Q106.5 30.9 109.2 33L103.4 32.8Z" fill="#e8f4ff"/>` +
  `<path d="M8.5 31.6L13.4 29.6L13 31.7L8.4 33.2Z" fill="#e53935"/>` +
  `<path d="M103.2 42.5A12.2 12.2 0 0 0 78.8 42.5M41.2 42.5A12.2 12.2 0 0 0 16.8 42.5" fill="none" stroke="#1a1d21" stroke-width="2.6"/>` +
  `<rect x="40.5" y="39.2" width="38.8" height="3.3" rx="1" fill="#1a1d21"/>` +
  `<path d="M8.5 38.6L16.9 38.9L17.2 42.5L11 42.5L8.6 41Z" fill="#1a1d21"/>` +
  `<path d="M103.1 38.7L111.6 38.2L111.6 39.5Q111.6 42.5 108 42.5L103.2 42.5Z" fill="#1a1d21"/>` +
  wheel(29) +
  wheel(91) +
  `</svg>`;

export const PROFILE_ICONS: Record<string, ProfileIconDef> = {
  "taycan-ct-green": {
    label: { en: "Green Taycan Cross Turismo", pl: "Zielony Taycan Cross Turismo" },
    ratio: 112 / 43,
    svg: TAYCAN_CT_GREEN
  }
};

export function profileIcon(id: string | null | undefined): ProfileIconDef | null {
  return id && Object.prototype.hasOwnProperty.call(PROFILE_ICONS, id) ? PROFILE_ICONS[id] : null;
}
