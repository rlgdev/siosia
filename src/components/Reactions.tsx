// 2.12.3 reactions (FR-330, FR-332): the row under a chat message or a session update — one chip per
// emoji someone set (how many; mine pressed; who, for screen readers and on hover), tapping a chip
// sets or takes back mine; the smiley opens the six to pick from (mine pressed: tapping it takes it
// back, another one replaces it). Read-only (no onReact): the chips alone, nothing to tap.

import { useEffect, useState } from "react";
import { REACTIONS } from "../core/reactions";
import type { Reaction } from "../core/types";
import { ServerError } from "../core/types";
import { useI18n } from "../i18n";
import type { Translate } from "../i18n";
import { Icon } from "./Icon";
import { useBusy } from "./ui";

/** "❤️: you, Anna" — who set it, me first. */
export function reactionLabel(r: Reaction, t: Translate): string {
  const who = [...(r.mine ? [t("react.you")] : []), ...r.names];
  return t("react.label", { emoji: r.emoji, names: who.join(", ") });
}

export function Reactions({ reactions, onReact, testId }: { reactions: Reaction[] | undefined; onReact?: (emoji: string | null) => Promise<unknown>; testId: string }) {
  const { t } = useI18n();
  const list = reactions ?? [];
  const [picking, setPicking] = useState(false);
  const [busy, run, error, setError] = useBusy();
  const mine = list.find((r) => r.mine)?.emoji ?? null;
  // The picker closes on Escape, like the app's dialogs.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicking(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking]);
  if (!list.length && !onReact) return null;
  const set = (emoji: string | null) => {
    setPicking(false);
    if (!onReact) return;
    void run(async () => {
      try {
        await onReact(emoji);
      } catch (e) {
        if (e instanceof ServerError && e.code === "too_many") return setError(t("react.tooMany"));
        if (e instanceof ServerError && e.code === "illegal_transition") return setError(t("react.closed"));
        throw e;
      }
    });
  };
  return (
    <div className="reactions" data-testid={testId}>
      <div className="reaction-row">
        {list.map((r) =>
          onReact ? (
            <button
              key={r.emoji}
              type="button"
              className="reaction-chip"
              aria-pressed={r.mine}
              aria-label={reactionLabel(r, t)}
              title={reactionLabel(r, t)}
              disabled={busy}
              onClick={() => set(r.mine ? null : r.emoji)}
              data-testid={`${testId}-chip`}
            >
              <span className="reaction-pill">
                <span aria-hidden="true">{r.emoji}</span>
                <span className="reaction-count">{r.count}</span>
              </span>
            </button>
          ) : (
            <span key={r.emoji} className="reaction-chip static" role="img" aria-label={reactionLabel(r, t)} title={reactionLabel(r, t)} data-testid={`${testId}-chip`}>
              <span className="reaction-pill">
                <span aria-hidden="true">{r.emoji}</span>
                <span className="reaction-count">{r.count}</span>
              </span>
            </span>
          )
        )}
        {onReact && (
          <button
            type="button"
            className="reaction-add"
            aria-label={t("react.add")}
            aria-expanded={picking}
            disabled={busy}
            onClick={() => setPicking((p) => !p)}
            data-testid={`${testId}-add`}
          >
            <span className="reaction-pill">
              <Icon name="smile" size={18} />
            </span>
          </button>
        )}
      </div>
      {picking && (
        <div className="reaction-picker" role="group" aria-label={t("react.pick")} data-testid={`${testId}-picker`}>
          {REACTIONS.map((e) => (
            <button key={e} type="button" className="reaction-pick" aria-pressed={mine === e} aria-label={e} onClick={() => set(mine === e ? null : e)} data-testid={`${testId}-pick`}>
              {e}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
