// 2.11 on the weekly report (FR-321–325): what is still to pay between my side (my family, else me)
// and each other side — both ways (services, rides) and the net; "Ask to pay" when they owe us (once
// per 12 h); "dobry Pancio", after a confirmation, settles everything between the two sides (the
// balance drops to zero, the other side hears it). Below, the recent dobry Pancios: the side that got
// one may answer it with a comment, once.

import { useState, type FormEvent } from "react";
import { InfoTip } from "../components/InfoTip";
import { Icon } from "../components/Icon";
import { agoText } from "../components/Notifications";
import { Confirm, Notice, useBusy } from "../components/ui";
import { formatMoney } from "../core/fare";
import type { DueLine, SettlementView, WeeklyReport } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

/** One reminder per side and 12 hours (V79). */
const REMIND_MS = 12 * 3600_000;
const COMMENT_MAX = 280;

export function DueSection({ report, onChanged }: { report: WeeklyReport; onChanged: () => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState<string | null>(null);
  if (!report.due.length && !report.settlements.length && !note) return null;
  return (
    <section className="card stack" data-testid="due">
      <div className="row spread">
        <strong className="due-title">
          <Icon name="wallet" className="ico-inline" /> {t("due.title")}
        </strong>
        <InfoTip text={t("due.hint")} testId="due" />
      </div>
      {note && (
        <Notice kind="ok">
          <span data-testid="due-note">{note}</span>
        </Notice>
      )}
      {report.due.length === 0 ? (
        <p className="muted" data-testid="due-none">
          {t("due.allSettled")}
        </p>
      ) : (
        report.due.map((d) => <DueItem key={d.party} line={d} currency={report.currency} onNote={setNote} onChanged={onChanged} />)
      )}
      {report.settlements.length > 0 && (
        <>
          <h3 className="due-history">{t("due.history")}</h3>
          {report.settlements.map((s) => (
            <SettlementItem key={s.id} s={s} currency={report.currency} onChanged={onChanged} />
          ))}
        </>
      )}
    </section>
  );
}

function DueItem({ line, currency, onNote, onChanged }: { line: DueLine; currency: string; onNote: (n: string) => void; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [asking, setAsking] = useState(false);
  const tz = app.deployment?.timezone ?? "Europe/Warsaw";
  const now = store.serverNow();
  const fmt = (n: number) => formatMoney(n, currency, locale);
  const amount = fmt(Math.abs(line.net));
  const recently = line.remindedAt !== null && now < line.remindedAt + REMIND_MS;
  const parts = [
    { v: line.theyOwe.services, key: "due.theyOweLine", what: "due.services" },
    { v: line.theyOwe.rides, key: "due.theyOweLine", what: "due.rides" },
    { v: line.weOwe.services, key: "due.weOweLine", what: "due.services" },
    { v: line.weOwe.rides, key: "due.weOweLine", what: "due.rides" }
  ] as const;
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: tz }).format(line.since);
  const question = t(line.net > 0 ? "due.confirmIn" : line.net < 0 ? "due.confirmOut" : "due.confirmEven", { amount, who: line.who });
  return (
    <div className="due-item stack" data-testid="due-line">
      <div className="row spread">
        <strong>{line.who}</strong>
        <span className={`due-net${line.net > 0 ? " due-in" : line.net < 0 ? " due-out" : ""}`} data-testid="due-net">
          {t(line.net > 0 ? "due.owedToYou" : line.net < 0 ? "due.youOwe" : "due.even")}
          {line.net !== 0 && ` ${amount}`}
        </span>
      </div>
      {parts
        .filter((p) => p.v !== 0) // below 0: a correction after a dobry Pancio, owed back
        .map((p) => (
          <div key={`${p.key}-${p.what}`} className="row spread due-part">
            <small className="muted">{t(p.key, { what: t(p.what) })}</small>
            <small>{fmt(p.v)}</small>
          </div>
        ))}
      <small className="muted">{t("due.since", { date, count: line.count })}</small>
      {error && <p className="form-error">{error}</p>}
      <div className="row due-actions">
        {line.net > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy || recently}
            onClick={() =>
              void run(async () => {
                await store.api.remindPayment(line.party);
                onNote(t("due.remindSent", { who: line.who }));
                onChanged();
              })
            }
            data-testid="due-remind"
          >
            {recently ? t("due.reminded", { ago: agoText(line.remindedAt!, now, locale) }) : t("due.remind")}
          </button>
        )}
        <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => setAsking(true)} data-testid="due-settle">
          <Icon name="check" className="ico-inline" /> {t("due.settle")}
        </button>
      </div>
      <Confirm
        open={asking}
        message={question}
        confirmLabel={t("due.settle")}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void run(async () => {
            await store.api.settleUp(line.party);
            onNote(t("due.settled", { who: line.who }));
            onChanged();
          });
        }}
      />
    </div>
  );
}

function SettlementItem({ s, currency, onChanged }: { s: SettlementView; currency: string; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [text, setText] = useState("");
  const amount = formatMoney(s.amount, currency, locale);
  const what =
    s.direction === "in" ? t("due.in", { who: s.who, amount }) : s.direction === "out" ? t("due.out", { who: s.who, amount }) : t("due.evenWith", { who: s.who });
  const send = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await store.api.commentSettlement(s.id, text);
      setText("");
      onChanged();
    });
  };
  return (
    <div className="due-item stack" data-testid="settlement">
      <strong className={s.direction === "in" ? "due-in" : undefined}>{what}</strong>
      <small className="muted">{t("due.by", { by: s.by, ago: agoText(s.at, store.serverNow(), locale) })}</small>
      {s.comment && (
        <p className="due-comment" data-testid="settlement-comment">
          {t("due.commentBy", { by: s.comment.by, text: s.comment.text })}
        </p>
      )}
      {s.canComment && (
        <form className="stack" onSubmit={send}>
          <label className="field">
            <span>{t("due.comment")}</span>
            <textarea
              rows={2}
              maxLength={COMMENT_MAX}
              value={text}
              placeholder={t("due.commentPlaceholder")}
              onChange={(e) => setText(e.target.value)}
              data-testid="settlement-comment-input"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn-secondary btn-small" disabled={busy || !text.trim()} data-testid="settlement-comment-send">
            {t("due.commentSend")}
          </button>
        </form>
      )}
    </div>
  );
}
