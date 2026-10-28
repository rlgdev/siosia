// 2.6 H1 → Weekly report (FR-280–283): one week, Monday to Sunday in the deployment's timezone —
// Spent (services as a client, rides as a passenger), Earned (services as a provider, rides as a
// driver), the balance; ‹ › steps a week (52 back at most); a member of a family switches to Family
// (the sums of all its members, one line each). Opened from H1 and from ./?open=report&week=.

import { useCallback, useEffect, useState } from "react";
import { InfoTip } from "../components/InfoTip";
import { Icon } from "../components/Icon";
import { Money, Panel } from "../components/ui";
import { addDays, weekOf } from "../core/time";
import type { ReportSide, WeeklyReport } from "../core/types";
import { useI18n } from "../i18n";
import { useApp, useListsKey, useStore } from "../state/store";
import { durationText, EntryIcon, localText } from "./Catalog";

const WEEKS_BACK = 52;

export function ReportPanel() {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const tz = app.deployment?.timezone ?? "Europe/Warsaw";
  const current = weekOf(store.serverNow(), tz);
  const [week, setWeek] = useState<string>(() => (app.panelArg ? weekOf(Date.parse(`${app.panelArg}T12:00:00Z`), tz) : current));
  const [scope, setScope] = useState<"me" | "family">("me");
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setReport(await store.api.report(week, scope));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [store, week, scope]);
  const listsKey = useListsKey();
  useEffect(() => {
    void load();
  }, [load, listsKey]);

  const day = (ms: number) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: tz }).format(ms);
  const shown = report && report.week === week ? report : null;
  const oldest = addDays(current, -7 * WEEKS_BACK);

  return (
    <Panel title={t("report.title")} onClose={() => store.closePanel()}>
      <section className="card stack" data-testid="report">
        <div className="row spread">
          <button type="button" className="icon-btn" aria-label={t("report.prev")} disabled={week <= oldest} onClick={() => setWeek(addDays(week, -7))} data-testid="report-prev">
            <Icon name="back" />
          </button>
          <strong data-testid="report-week">{shown ? `${day(shown.weekStart)} – ${day(shown.weekEnd - 1)}` : week}</strong>
          <button type="button" className="icon-btn" aria-label={t("report.next")} disabled={week >= current} onClick={() => setWeek(addDays(week, 7))} data-testid="report-next">
            <Icon name="chevron" />
          </button>
        </div>
        <div className="row spread">
          {shown?.hasFamily ? (
            <div className="segmented" role="group">
              {(["me", "family"] as const).map((s) => (
                <button key={s} type="button" className={scope === s ? "btn btn-primary btn-small" : "btn btn-secondary btn-small"} aria-pressed={scope === s} onClick={() => setScope(s)} data-testid={`report-${s}`}>
                  {t(s === "me" ? "report.me" : "report.family")}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <InfoTip text={t("report.hint")} testId="report" />
        </div>
      </section>
      {failed && !report ? (
        <div className="row spread">
          <p className="form-error">{t("report.error")}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : !shown ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <>
          <div className="totals" data-testid="report-totals">
            <div className="total-card">
              <small>{t("report.spent")}</small>
              <strong data-testid="report-spent">
                <Money amount={shown.spent.total} currency={shown.currency} />
              </strong>
            </div>
            <div className="total-card">
              <small>{t("report.earned")}</small>
              <strong data-testid="report-earned">
                <Money amount={shown.earned.total} currency={shown.currency} />
              </strong>
            </div>
            <div className="total-card">
              <small>{t("report.net")}</small>
              <strong data-testid="report-net">
                <Money amount={shown.net} currency={shown.currency} />
              </strong>
            </div>
          </div>
          {!hasAny(shown.spent) && !hasAny(shown.earned) ? (
            <p className="muted" data-testid="report-empty">
              {t("report.empty")}
            </p>
          ) : (
            <>
              <Side title={t("report.spent")} side={shown.spent} currency={shown.currency} testId="report-spent-lines" />
              <Side title={t("report.earned")} side={shown.earned} currency={shown.currency} testId="report-earned-lines" />
            </>
          )}
          {shown.members && (
            <section className="card stack" data-testid="report-members">
              <strong>{t("report.members")}</strong>
              {shown.members.map((m) => (
                <div key={m.nickname} className="row spread">
                  <span>{m.nickname}</span>
                  <small className="muted">
                    {t("report.memberLine", { spent: money(m.spent, shown.currency, locale), earned: money(m.earned, shown.currency, locale) })}
                  </small>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </Panel>
  );
}

const hasAny = (s: ReportSide) => s.services.length > 0 || s.rides.count > 0;

const money = (amount: number, currency: string, locale: string) => {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/** One side's lines: per other person and service (count, time, total), then the rides. */
function Side({ title, side, currency, testId }: { title: string; side: ReportSide; currency: string; testId: string }) {
  const { t, lang } = useI18n();
  const app = useApp();
  if (!hasAny(side)) return null;
  const services = app.deployment?.services ?? [];
  return (
    <section className="card stack" data-testid={testId}>
      <div className="row spread">
        <strong>{title}</strong>
        <Money amount={side.total} currency={currency} />
      </div>
      {side.services.map((l) => {
        const e = services.find((s) => s.id === l.serviceId);
        return (
          <div key={`${l.who}-${l.serviceId}`} className="row spread report-line" data-testid="report-line">
            <span>
              {e && <EntryIcon icon={e.icon} />} {localText(e?.name, lang) || l.serviceId} · {l.who}
              <br />
              <small className="muted">{t("report.line", { count: l.count, time: durationText(l.minutes, t) })}</small>
            </span>
            <Money amount={l.total} currency={currency} />
          </div>
        );
      })}
      {side.rides.count > 0 && (
        <div className="row spread report-line" data-testid="report-rides">
          <span>
            <Icon name="car" className="ico-inline" /> {t("report.rides")} · {t("report.ridesCount", { n: side.rides.count })}
          </span>
          <Money amount={side.rides.total} currency={currency} />
        </div>
      )}
      {/* 2.9 (FR-316): tips given or received, part of the total */}
      {side.tips > 0 && (
        <div className="row spread report-line" data-testid="report-tips">
          <span>
            <Icon name="sparkles" className="ico-inline" /> {t("report.tips")}
          </span>
          <Money amount={side.tips} currency={currency} />
        </div>
      )}
    </section>
  );
}
