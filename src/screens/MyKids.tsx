// S2 → My kids (FR-200, FR-203, FR-204): the kids' profiles kept on this account — first name,
// photo, year of birth, note (allergies and the like) — at most 8; each card shows the kid's
// rating and, unfolded, every rating it got (who, when, stars, comment). Only the owner sees any
// of this; a kid reaches the provider of an appointment only when attached to it (C2 / C3).

import { useCallback, useEffect, useState } from "react";
import { InfoTip } from "../components/InfoTip";
import { KidAvatar, kidAge, KidRating } from "../components/Kids";
import { PhotoPicker } from "../components/PhotoPicker";
import { Confirm, useBusy } from "../components/ui";
import type { Kid, KidInput } from "../core/types";
import { ServerError } from "../core/types";
import { useI18n } from "../i18n";
import { useStore } from "../state/store";

export const MAX_KIDS = 8;

export function MyKids() {
  const { t } = useI18n();
  const store = useStore();
  const [kids, setKids] = useState<Kid[] | null>(null);
  const [failed, setFailed] = useState(false);
  // "new" = the add form is open; a kid id = that kid is being edited.
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [removing, setRemoving] = useState<Kid | null>(null);
  const [busy, run, error] = useBusy();
  // Through a promise: a backend without the call (an older server) fails softly, the rest of S2 stays.
  const load = useCallback(
    () =>
      Promise.resolve()
        .then(() => store.api.kids())
        .then(
          (list) => (setKids(list), setFailed(false)),
          () => setFailed(true)
        ),
    [store]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const remove = (kid: Kid) =>
    run(async () => {
      try {
        await store.api.removeKid(kid.id);
      } finally {
        await load();
      }
    });

  return (
    <section className="card stack" data-testid="my-kids">
      <h3 className="with-info">
        {t("kids.title")}
        <InfoTip text={t("kids.hint")} testId="my-kids" />
      </h3>
      {failed && !kids ? (
        <div className="row spread">
          <p className="form-error">{t("kids.error")}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : !kids ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <>
          {kids.length === 0 && editing !== "new" && (
            <p className="muted small" data-testid="kids-empty">
              {t("kids.empty")}
            </p>
          )}
          {kids.map((k) =>
            editing === k.id ? (
              <KidForm
                key={k.id}
                kid={k}
                onDone={() => {
                  setEditing(null);
                  void load();
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <KidCard key={k.id} kid={k} onEdit={() => setEditing(k.id)} onRemove={() => setRemoving(k)} reload={load} />
            )
          )}
          {editing === "new" ? (
            <KidForm
              kid={null}
              onDone={() => {
                setEditing(null);
                void load();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : kids.filter((k) => k.mine !== false).length < MAX_KIDS ? (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing("new")} data-testid="kid-add">
              {t("kids.add")}
            </button>
          ) : (
            <p className="muted small">{t("kids.max")}</p>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Confirm
        open={!!removing}
        danger
        message={t("kids.removeConfirm", { name: removing?.name ?? "" })}
        confirmLabel={t("kids.remove")}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const kid = removing;
          setRemoving(null);
          if (kid) void remove(kid);
        }}
      />
    </section>
  );
}

/** One kid: photo (with its picker), name, age, rating, note; Edit, the ratings list, Remove. */
function KidCard({ kid, onEdit, onRemove, reload }: { kid: Kid; onEdit: () => void; onRemove: () => void; reload: () => Promise<void> }) {
  const { t, locale } = useI18n();
  const [showRatings, setShowRatings] = useState(false);
  const age = kidAge(kid.bornYear);
  const date = (ms: number) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(ms);
  return (
    <div className="kid-card stack" data-testid={`kid-card-${kid.id}`}>
      <div className="row">
        <KidAvatar kid={kid} size="md" />
        <div className="grow">
          <strong data-testid="kid-card-name">{kid.name}</strong>
          {age !== null && <span className="muted small"> · {t("kids.age", { n: age })}</span>}
          {kid.mine === false && (
            <span className="muted small" data-testid="kid-owner">
              {" "}
              · {t("kids.addedBy", { name: kid.ownerNickname })}
            </span>
          )}
          <KidRating kid={kid} />
          {kid.note && <p className="note small">„{kid.note}”</p>}
        </div>
      </div>
      <PhotoPicker target={{ kind: "kid", id: kid.id }} current={kid.photo} onChanged={reload} testId={`kid-photo-${kid.id}`} />
      <div className="row wrap">
        <button type="button" className="btn btn-link btn-small" onClick={onEdit} data-testid={`kid-edit-${kid.id}`}>
          {t("kids.edit")}
        </button>
        <button type="button" className="btn btn-link btn-small" aria-expanded={showRatings} onClick={() => setShowRatings((s) => !s)} data-testid={`kid-ratings-${kid.id}`}>
          {t("kids.ratings", { n: kid.ratings.length })}
        </button>
        <button type="button" className="btn btn-link danger btn-small" onClick={onRemove} data-testid={`kid-remove-${kid.id}`}>
          {t("kids.remove")}
        </button>
      </div>
      {showRatings && (
        <ul className="kid-ratings" data-testid={`kid-ratings-list-${kid.id}`}>
          {kid.ratings.length === 0 ? (
            <li className="muted small">{t("kids.noRatings")}</li>
          ) : (
            kid.ratings.map((r) => (
              <li key={`${r.appointmentId}:${r.at}`} className="small">
                <span className="stars-text" aria-label={t("common.stars", { n: r.stars })}>
                  {"★".repeat(r.stars)}
                </span>{" "}
                <strong>{r.by}</strong> <span className="muted">{date(r.at)}</span>
                {r.comment && <span className="note"> „{r.comment}”</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Add or edit a kid: the name (1–30), the year of birth (optional), the note (≤ 200). */
function KidForm({ kid, onDone, onCancel }: { kid: Kid | null; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const store = useStore();
  const [name, setName] = useState(kid?.name ?? "");
  const [born, setBorn] = useState(kid?.bornYear ? String(kid.bornYear) : "");
  const [note, setNote] = useState(kid?.note ?? "");
  const [busy, run, error, setError] = useBusy();
  const thisYear = new Date().getFullYear();
  // Kids: the last 25 years are plenty (the server allows any year since 1900).
  const years: number[] = [];
  for (let y = thisYear; y >= thisYear - 25; y--) years.push(y);
  const valid = name.trim().length >= 1 && name.trim().length <= 30 && note.length <= 200;
  const save = () =>
    run(async () => {
      const input: KidInput = { name: name.trim(), bornYear: born ? Number(born) : null, note: note.trim() };
      try {
        if (kid) await store.api.updateKid(kid.id, input);
        else await store.api.addKid(input);
      } catch (e) {
        // The 9th kid (a second tab added one meanwhile): the limit on kids, not the one on bookings (C18).
        if (e instanceof ServerError && e.code === "too_many") return setError(t("kids.max"));
        throw e;
      }
      onDone();
    });
  return (
    <form
      className="kid-card stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save();
      }}
      data-testid="kid-form"
    >
      <label className="field">
        <span>{t("kids.name")}</span>
        <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} autoFocus data-testid="kid-name" />
      </label>
      <label className="field">
        <span>{t("kids.born")}</span>
        <select value={born} onChange={(e) => setBorn(e.target.value)} data-testid="kid-born">
          <option value="">{t("kids.bornNone")}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t("kids.note")}</span>
        <textarea value={note} maxLength={200} rows={2} onChange={(e) => setNote(e.target.value)} placeholder={t("kids.notePlaceholder")} data-testid="kid-note" />
        <small>{t("request.noteLeft", { n: 200 - note.length })}</small>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy || !valid} data-testid="kid-save">
          {t("common.save")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} data-testid="kid-cancel">
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
