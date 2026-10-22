// 2.3 kids (FR-200–203): the pieces S2, C2 and C3 share — a kid's avatar, the picker of the
// client's own kids (C2, and Change on C3), the cards of the attached kids as the other party
// sees them (name, photo, age, note, rating) and the provider's rate-a-kid box after the
// appointment is done. Who may see what is decided by the server (V44): the views carry only it.

import { useCallback, useEffect, useState } from "react";
import type { AttachedKid, Kid } from "../core/types";
import { useI18n } from "../i18n";
import { useStore } from "../state/store";
import { Avatar, Initial } from "./ProfileIcon";
import { RatingBadge, StarInput, useBusy } from "./ui";

/** Years from the year of birth (null without one). */
export const kidAge = (bornYear: number | null, now = Date.now()): number | null => (bornYear === null ? null : new Date(now).getFullYear() - bornYear);

export function KidAvatar({ kid, size = "sm" }: { kid: { name: string; photo: string | null }; size?: "sm" | "md" }) {
  return <Avatar photo={kid.photo} size={size} fallback={<Initial name={kid.name} />} />;
}

/** "★ 4.5 (3)" — the kid's own ratings (never the owner's, V45); "New" without any. */
export function KidRating({ kid }: { kid: { rating: AttachedKid["rating"] } }) {
  return (
    <span className="row" data-testid="kid-rating">
      <RatingBadge rating={kid.rating} />
      {kid.rating.count > 0 && <span className="muted small">({kid.rating.count})</span>}
    </span>
  );
}

/**
 * My kids from the server, for the pickers. A backend without kids (or a failure) gives none:
 * the picker simply does not show.
 */
export function useMyKids(enabled = true): [Kid[] | null, () => Promise<void>] {
  const store = useStore();
  const [kids, setKids] = useState<Kid[] | null>(null);
  const load = useCallback(async () => {
    const list = await Promise.resolve()
      .then(() => store.api.kids())
      .catch(() => [] as Kid[]);
    setKids(list);
  }, [store]);
  useEffect(() => {
    if (enabled) void load();
  }, [load, enabled]);
  return [kids, load];
}

/** A tick per own kid (C2, C3 Change): photo, name, age. */
export function KidPicker({ kids, selected, onChange, disabled }: { kids: Kid[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="stack" data-testid="kid-picker">
      {kids.map((k) => {
        const age = kidAge(k.bornYear);
        return (
          <label key={k.id} className="switch-row">
            <input
              type="checkbox"
              checked={selected.includes(k.id)}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? [...selected, k.id] : selected.filter((x) => x !== k.id))}
              data-testid={`kid-${k.id}`}
            />
            <KidAvatar kid={k} />
            <span>
              {k.name}
              {age !== null && <span className="muted small"> · {t("kids.age", { n: age })}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** The attached kids as a party of the appointment sees them (FR-202): name, photo, age, note, rating. */
export function AttachedKidCards({ kids }: { kids: AttachedKid[] }) {
  const { t } = useI18n();
  return (
    <ul className="kid-list" data-testid="attached-kids">
      {kids.map((k) => (
        <li key={k.id} className="row kid-row" data-testid={`attached-kid-${k.id}`}>
          <KidAvatar kid={k} />
          <div className="grow">
            <strong>{k.name}</strong>
            {k.age !== null && <span className="muted small"> · {t("kids.age", { n: k.age })}</span>} <KidRating kid={k} />
            {k.note && <p className="note small">„{k.note}”</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The provider rates one attached kid once the appointment is done (FR-203): stars and a short
 * comment, once; afterwards the line says what was given.
 */
export function RateKidBox({ appointmentId, kid, onRated }: { appointmentId: string; kid: AttachedKid; onRated: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, run, error] = useBusy();
  if (kid.myRating !== null)
    return (
      <p className="muted small" data-testid={`rate-kid-${kid.id}`}>
        {t("appt.kidRated", { name: kid.name, n: kid.myRating })}
      </p>
    );
  return (
    <div className="stack kid-rate" data-testid={`rate-kid-${kid.id}`}>
      <strong className="row">
        <KidAvatar kid={kid} /> {t("appt.rateKid", { name: kid.name })}
      </strong>
      <StarInput value={stars} onChange={setStars} disabled={busy} />
      <input value={comment} maxLength={140} onChange={(e) => setComment(e.target.value)} placeholder={t("receipt.comment")} aria-label={t("receipt.comment")} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || stars < 1}
        onClick={() => void run(async () => (await store.api.rateKid(appointmentId, kid.id, stars, comment.trim()), onRated()))}
        data-testid={`rate-kid-${kid.id}-send`}
      >
        {t("receipt.sendRating")}
      </button>
    </div>
  );
}
