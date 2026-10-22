// A round "i" next to a heading or control (FR-190): the explanation that used to sit on the screen
// as a paragraph now pops up for 5 s when the icon is tapped (tap again, or anywhere, to close it
// sooner). Screens stay short; the words are unchanged.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";

export const INFO_TIP_MS = 5000;

export function InfoTip({ text, testId, ms = INFO_TIP_MS }: { text: ReactNode; testId?: string; ms?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const pop = useRef<HTMLSpanElement>(null);
  // The icon may sit near a screen edge: shift the popup so it stays inside the viewport.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    el.style.transform = "translateX(-50%)";
    const r = el.getBoundingClientRect();
    const margin = 12;
    const over = r.left < margin ? margin - r.left : r.right > window.innerWidth - margin ? window.innerWidth - margin - r.right : 0;
    if (over) el.style.transform = `translateX(calc(-50% + ${Math.round(over)}px))`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setOpen(false), ms);
    // A tap anywhere else closes it at once.
    const away = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest(`[data-infotip="${id}"]`)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [open, id, ms]);
  return (
    <span className="infotip" data-infotip={id}>
      <button
        type="button"
        className={`infotip-btn${open ? " is-on" : ""}`}
        aria-label={t("common.info")}
        aria-expanded={open}
        aria-describedby={open ? `${id}-text` : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId ? `${testId}-info` : "info-tip"}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open && (
        <span ref={pop} className="infotip-pop" role="tooltip" id={`${id}-text`} data-testid={testId ? `${testId}-tip` : "info-tip-text"}>
          {text}
        </span>
      )}
    </span>
  );
}
