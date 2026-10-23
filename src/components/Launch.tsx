// The launch (2.4, V52): over the boot, the app icon's S draws itself like a route, the mint pin
// drops in and lands with a ping, the word Siosia settles; then, once the boot has left
// "loading", the mark shrinks into S1's avatar while S1's rows spring in (html[data-launch]),
// or simply fades when another screen is under it. Once per page load (a cold start of the
// installed app, never a re-render or a resume), ≤ 2 s in all, a tap skips it, reduced motion
// gets a short fade, and `?launch=0` turns it off (the e2e suite).

import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/store";

/** The intro's length; "out" starts after it, or at once on a tap. */
export const LAUNCH_INTRO_MS = 1200;
/** The morph / fade out, after which the overlay is gone. */
export const LAUNCH_OUT_MS = 500;
/** With reduced motion: no intro, a short fade. */
export const LAUNCH_FADE_MS = 200;
/** A boot that is still loading after this long shows its own screen (Loading, then whatever comes). */
export const LAUNCH_CAP_MS = 4000;
/** S1's rows finish springing in this long after "out" began; `data-launch` leaves then. */
const ROWS_MS = 1200;

let finished = false;

/**
 * True until the launch of this page load has ended (so a dev-mode double render asks twice and
 * gets the same answer), never again after; `?launch=0` in the URL means none at all.
 */
export function launchWanted(): boolean {
  if (finished) return false;
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("launch") === "0") return false;
  return true;
}

/** The launch ended (or was skipped): no later mount of the app shell plays it again. */
export function launchFinished(): void {
  finished = true;
}

/** Tests only: the next page "load". */
export function resetLaunch(): void {
  finished = false;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where S1's avatar sits, as the transform that takes the overlay's 160 px mark there. */
function avatarTarget(): { x: number; y: number; s: number } | null {
  const el = document.querySelector<HTMLElement>(".home-head > :first-child");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const size = Math.min(r.width, r.height);
  return { x: r.left + r.width / 2 - window.innerWidth / 2, y: r.top + r.height / 2 - window.innerHeight / 2, s: size / 160 };
}

export function Launch({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const reduce = useRef(reducedMotion()).current;
  const [introDone, setIntroDone] = useState(reduce);
  const [capped, setCapped] = useState(false);
  const [out, setOut] = useState<null | { morph: { x: number; y: number; s: number } | null }>(null);
  const booted = app.phase !== "loading";

  useEffect(() => {
    const intro = setTimeout(() => setIntroDone(true), reduce ? 0 : LAUNCH_INTRO_MS);
    const cap = setTimeout(() => setCapped(true), LAUNCH_CAP_MS);
    return () => {
      clearTimeout(intro);
      clearTimeout(cap);
    };
  }, [reduce]);

  // Out: after the intro, as soon as the boot has shown a screen (or after the cap). The morph
  // only when S1 itself is under the overlay, with nothing over it.
  const onHome = app.phase === "ready" && app.screen === "home" && !app.panel;
  const wantOut = introDone && (booted || capped);
  useEffect(() => {
    if (!wantOut || out) return;
    setOut({ morph: !reduce && onHome ? avatarTarget() : null });
  }, [wantOut, out, onHome, reduce]);

  useEffect(() => {
    if (!out) return;
    const root = document.documentElement;
    if (out.morph) root.dataset.launch = "1";
    const done = setTimeout(() => {
      launchFinished();
      onDone();
    }, reduce ? LAUNCH_FADE_MS : LAUNCH_OUT_MS);
    // S1's rows keep their entrance until they have landed; the overlay itself is gone by then.
    const rows = setTimeout(() => delete root.dataset.launch, LAUNCH_OUT_MS + ROWS_MS);
    return () => {
      clearTimeout(done);
      clearTimeout(rows);
      delete root.dataset.launch;
    };
  }, [out, onDone, reduce]);

  const skip = () => {
    if (!out) setOut({ morph: !reduce && onHome ? avatarTarget() : null });
  };

  const cls = ["launch", out ? "launch-out" : "launch-in", out?.morph ? "launch-morph" : "", reduce ? "launch-reduced" : ""].filter(Boolean).join(" ");
  const style = out?.morph ? ({ "--lx": `${out.morph.x}px`, "--ly": `${out.morph.y}px`, "--ls": out.morph.s } as React.CSSProperties) : undefined;
  return (
    <div className={cls} aria-hidden="true" onPointerDown={skip} data-testid="launch" data-stage={out ? "out" : "in"}>
      <div className="launch-mark" style={style}>
        <svg viewBox="0 0 512 512" width="96" height="96" focusable="false" style={{ overflow: "visible" }}>
          <path className="launch-route" d="M323.7 159.4A72 72 0 1 0 256 256A72 72 0 1 1 188.3 352.6" fill="none" stroke="currentColor" strokeWidth="44" strokeLinecap="round" />
          <circle className="launch-ping" cx="382" cy="398" r="26" fill="none" strokeWidth="8" />
          <g className="launch-dot">
            <circle cx="382" cy="398" r="26" />
          </g>
        </svg>
      </div>
      {/* The word is drawn by CSS from the attribute: no text node for queries to trip over. */}
      <p className="launch-word" data-word="Siosia"></p>
    </div>
  );
}
