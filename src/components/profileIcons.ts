// Profile icons, chosen per master profile on the server (master_profiles.icon). Inline SVG only —
// no image assets, no brand logos. Flat fills (no gradients) so several copies on one page never
// fight over element ids.
//
// 2.1 (FR-170, V38): a car icon is drawn in the vehicle's paint. Its body colours — the paint, the
// darker lower body and trim, the lighter highlight — come from one chosen #rrggbb (shadesOf); the
// green Taycan keeps its hand-picked shades. `car` is the plain car of drivers without an icon.

import type { Lang } from "../core/types";

/** A car's body colours, all drawn from its paint. */
export interface CarShades {
  body: string;
  lower: string;
  highlight: string;
  trim: string;
}

interface ProfileIconDef {
  label: Record<Lang, string>;
  /** viewBox width : height, for sizing. */
  ratio: number;
  /** As drawn without a paint (the default green for a car). */
  svg: string;
  /** A car icon: the model for its label ("Red Taycan Cross Turismo") and the drawing in a paint. */
  car?: { model: Record<Lang, string>; draw: (s: CarShades) => string };
}

/** One of the colours a driver can pick for the car (FR-170). */
export interface CarPaint {
  id: string;
  hex: string;
  name: Record<Lang, string>;
}

export const CAR_PAINTS: CarPaint[] = [
  { id: "green", hex: "#2e7d4f", name: { en: "Green", pl: "Zielony" } },
  { id: "black", hex: "#1f2328", name: { en: "Black", pl: "Czarny" } },
  { id: "white", hex: "#eceff1", name: { en: "White", pl: "Biały" } },
  { id: "silver", hex: "#b8bec6", name: { en: "Silver", pl: "Srebrny" } },
  { id: "grey", hex: "#6b7280", name: { en: "Grey", pl: "Szary" } },
  { id: "blue", hex: "#1e5aa8", name: { en: "Blue", pl: "Niebieski" } },
  { id: "red", hex: "#c62828", name: { en: "Red", pl: "Czerwony" } },
  { id: "yellow", hex: "#f2c230", name: { en: "Yellow", pl: "Żółty" } },
  { id: "orange", hex: "#ef6c00", name: { en: "Orange", pl: "Pomarańczowy" } },
  { id: "brown", hex: "#6d4c41", name: { en: "Brown", pl: "Brązowy" } }
];

/** A car without a chosen paint is green (the Taycan's own colour). */
export const DEFAULT_PAINT = "#2e7d4f";

const GREEN: CarShades = { body: "#2e7d4f", lower: "#22603b", highlight: "#7cc896", trim: "#1d5233" };

/** "#C62828" → "#c62828"; anything that is not #rrggbb → null. */
export function normalPaint(paint: string | null | undefined): string | null {
  return paint && /^#[0-9a-f]{6}$/i.test(paint.trim()) ? paint.trim().toLowerCase() : null;
}

/** The palette entry of a paint, if it is one of the ten. */
export function carPaint(paint: string | null | undefined): CarPaint | null {
  const hex = normalPaint(paint);
  return CAR_PAINTS.find((p) => p.hex === hex) ?? null;
}

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

/** #rrggbb lightened toward white (amount > 0) or darkened toward black (amount < 0), 0…1. */
export function shade(hex: string, amount: number): string {
  const out = [0, 1, 2].map((i) => {
    const c = channel(hex, i);
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  });
  return `#${out.join("")}`;
}

/** The body colours of a car painted `paint` (null or not #rrggbb: the default green). */
export function shadesOf(paint: string | null | undefined): CarShades {
  const hex = normalPaint(paint);
  if (!hex || hex === GREEN.body) return GREEN;
  return { body: hex, lower: shade(hex, -0.25), highlight: shade(hex, 0.42), trim: shade(hex, -0.37) };
}

const wheel = (cx: number) =>
  `<g transform="translate(${cx} 42.5)"><circle r="8.3" fill="#121417"/><circle r="5.5" fill="#b9bfc6"/>` +
  `<circle r="5.5" fill="none" stroke="#7d848d" stroke-width=".8"/>` +
  `<path d="M0 0L0-4.8M0 0L4.57-1.48M0 0L2.82 3.88M0 0L-2.82 3.88M0 0L-4.57-1.48" stroke="#5f666e" stroke-width="1.3" stroke-linecap="round"/>` +
  `<circle r="1.3" fill="#3b4148"/></g>`;

// Taycan Cross Turismo, side view facing right: shooting-brake roof with rails, black wheel-arch
// cladding, light bar at the back, four-point headlight at the front.
const taycanCt = (s: CarShades) =>
  `<svg viewBox="4 12 112 43" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
  `<ellipse cx="60" cy="51.2" rx="52" ry="2.3" fill="#000" opacity=".2"/>` +
  `<path data-part="body" d="M11 42.5L8.6 41L8.4 34.5Q8.6 31 11 30L14.5 28Q19 22.5 24.5 20.2Q28 18.7 34 18.3L59 17.6Q64 17.5 67.5 19.6L79.5 27Q95 28 104.5 30.4Q110.5 32 111.6 35.8L111.6 39.5Q111.6 42.5 108 42.5L101.5 42.5A10.5 10.5 0 0 0 80.5 42.5L39.5 42.5A10.5 10.5 0 0 0 18.5 42.5Z" fill="${s.body}"/>` +
  `<path d="M8.5 37.6Q60 35.3 111.6 37.9L111.6 39.5Q111.6 42.5 108 42.5L101.5 42.5A10.5 10.5 0 0 0 80.5 42.5L39.5 42.5A10.5 10.5 0 0 0 18.5 42.5L11 42.5L8.6 41Z" fill="${s.lower}"/>` +
  `<path d="M12 31.8Q60 28.6 106 31.3" fill="none" stroke="${s.highlight}" stroke-width="1.1" opacity=".6"/>` +
  `<path d="M21.2 27.4Q23 22.6 26.5 20.9Q29 19.9 34 19.7L59 19.1Q62.5 19.1 65.2 20.7L75.6 27.6Z" fill="#1c2733"/>` +
  `<path d="M55 19.4L60.2 19.3L54.6 27.6L50.2 27.6Z" fill="#fff" opacity=".13"/>` +
  `<path d="M32.5 19.8L31.8 27.4" stroke="${s.body}" stroke-width="2.4"/>` +
  `<path d="M50.4 19.3L49.9 27.6" stroke="#0e1318" stroke-width="1.9"/>` +
  `<path d="M28 17.1L58.5 16.1" stroke="#15181c" stroke-width="1.5" stroke-linecap="round"/>` +
  `<path d="M30 17V18.4M56.5 16.2V17.6" stroke="#15181c" stroke-width="1.1"/>` +
  `<path d="M50.2 28.2L49.9 39M73.6 28.4Q74.4 33.5 73.8 39" stroke="${s.trim}" stroke-width=".8" fill="none"/>` +
  `<rect x="42.6" y="30" width="4.2" height="1.1" rx=".55" fill="${s.trim}"/>` +
  `<rect x="65.6" y="30.4" width="4.2" height="1.1" rx=".55" fill="${s.trim}"/>` +
  `<path d="M74 26.6L77.6 25.9L78 27.6L74.7 28Z" fill="${s.lower}"/>` +
  `<path d="M101.6 30.4Q106.5 30.9 109.2 33L103.4 32.8Z" fill="#e8f4ff"/>` +
  `<path d="M8.5 31.6L13.4 29.6L13 31.7L8.4 33.2Z" fill="#e53935"/>` +
  `<path d="M103.2 42.5A12.2 12.2 0 0 0 78.8 42.5M41.2 42.5A12.2 12.2 0 0 0 16.8 42.5" fill="none" stroke="#1a1d21" stroke-width="2.6"/>` +
  `<rect x="40.5" y="39.2" width="38.8" height="3.3" rx="1" fill="#1a1d21"/>` +
  `<path d="M8.5 38.6L16.9 38.9L17.2 42.5L11 42.5L8.6 41Z" fill="#1a1d21"/>` +
  `<path d="M103.1 38.7L111.6 38.2L111.6 39.5Q111.6 42.5 108 42.5L103.2 42.5Z" fill="#1a1d21"/>` +
  wheel(29) +
  wheel(91) +
  `</svg>`;

// A plain saloon in the same frame (same wheels and shadow): drivers without a profile icon.
const plainCar = (s: CarShades) =>
  `<svg viewBox="4 12 112 43" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
  `<ellipse cx="60" cy="51.2" rx="52" ry="2.3" fill="#000" opacity=".2"/>` +
  `<path data-part="body" d="M10 42.5L8.5 40L8.5 34Q9 31 12 30.5L24 29L36 20.5Q38.5 19 42 19L74 19Q78 19 80.5 21L91 29L106 30.5Q111 31.3 111.5 35L111.5 40Q111.5 42.5 108.5 42.5L101.5 42.5A10.5 10.5 0 0 0 80.5 42.5L39.5 42.5A10.5 10.5 0 0 0 18.5 42.5Z" fill="${s.body}"/>` +
  `<path d="M8.5 37.5L111.5 37.5L111.5 40Q111.5 42.5 108.5 42.5L101.5 42.5A10.5 10.5 0 0 0 80.5 42.5L39.5 42.5A10.5 10.5 0 0 0 18.5 42.5L10 42.5L8.5 40Z" fill="${s.lower}"/>` +
  `<path d="M12 32.6Q60 30.6 106 32.4" fill="none" stroke="${s.highlight}" stroke-width="1.1" opacity=".6"/>` +
  `<path d="M28 28.6L38.5 21.3Q40 20.6 42.5 20.6L57.5 20.6L57.5 28.6Z" fill="#1c2733"/>` +
  `<path d="M60.5 20.6L73.5 20.6Q76.5 20.6 78.5 22L87 28.6L60.5 28.6Z" fill="#1c2733"/>` +
  `<path d="M59 21L59 37.5M86 29.4Q87 33.5 86.4 37.5" stroke="${s.trim}" stroke-width=".8" fill="none"/>` +
  `<rect x="48" y="31" width="4.2" height="1.1" rx=".55" fill="${s.trim}"/>` +
  `<rect x="74" y="31" width="4.2" height="1.1" rx=".55" fill="${s.trim}"/>` +
  `<path d="M104 31.4Q108.5 32 110.4 34L104.6 33.6Z" fill="#e8f4ff"/>` +
  `<path d="M8.6 32.2L12.6 31L12.4 33.2L8.5 34.2Z" fill="#e53935"/>` +
  `<path d="M103.2 42.5A12.2 12.2 0 0 0 78.8 42.5M41.2 42.5A12.2 12.2 0 0 0 16.8 42.5" fill="none" stroke="#1a1d21" stroke-width="2.6"/>` +
  wheel(29) +
  wheel(91) +
  `</svg>`;

export const PROFILE_ICONS: Record<string, ProfileIconDef> = {
  "taycan-ct-green": {
    label: { en: "Green Taycan Cross Turismo", pl: "Zielony Taycan Cross Turismo" },
    ratio: 112 / 43,
    svg: taycanCt(GREEN),
    car: { model: { en: "Taycan Cross Turismo", pl: "Taycan Cross Turismo" }, draw: taycanCt }
  },
  car: {
    label: { en: "Car", pl: "Samochód" },
    ratio: 112 / 43,
    svg: plainCar(GREEN),
    car: { model: { en: "car", pl: "samochód" }, draw: plainCar }
  }
};

/** The plain car icon (a driver with a vehicle but no profile icon). */
export const PLAIN_CAR = "car";

export function profileIcon(id: string | null | undefined): ProfileIconDef | null {
  return id && Object.prototype.hasOwnProperty.call(PROFILE_ICONS, id) ? PROFILE_ICONS[id] : null;
}

/** Is this icon a car (drawn in a paint, FR-170)? */
export const isCarIcon = (id: string | null | undefined) => !!profileIcon(id)?.car;

/** The icon's SVG; a car in `paint` (null: as designed). */
export function iconSvg(def: ProfileIconDef, paint?: string | null): string {
  return def.car && normalPaint(paint) ? def.car.draw(shadesOf(paint)) : def.svg;
}

/** "Green Taycan Cross Turismo" / "Czerwony samochód" — the car's label in its paint. */
export function iconLabel(def: ProfileIconDef, paint: string | null | undefined, lang: Lang): string {
  if (!def.car || !normalPaint(paint)) return def.label[lang];
  const named = carPaint(paint);
  const model = def.car.model[lang];
  return named ? `${named.name[lang]} ${model}` : model.charAt(0).toUpperCase() + model.slice(1);
}
