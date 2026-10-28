// 2.6 S2 → Family & contracts (FR-250–252, FR-260–264): my family — its people, the invitations it
// sent, those waiting for me, Invite (a member picked from the list), Leave — and the contracts of
// my family and mine as a provider: waiting (Accept / Decline or Withdraw), active (rates, End,
// Propose new rates), earlier ones folded; Propose a contract (as the family or as the provider).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
import { Avatar, Initial } from "../components/ProfileIcon";
import { Confirm, Money, Panel, useBusy } from "../components/ui";
import type { ContractRate, ContractView, FamilyView, PublicProvider } from "../core/types";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { useApp, useListsKey, useStore } from "../state/store";
import { EntryIcon, localText } from "./Catalog";

export function FamilyPanel() {
  const { t } = useI18n();
  const store = useStore();
  const [family, setFamily] = useState<FamilyView | null>(null);
  const [contracts, setContracts] = useState<ContractView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const [f, c] = await Promise.all([store.api.family(), store.api.contracts()]);
      setFamily(f);
      setContracts(c);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [store]);
  // Another member's answer, a new invitation or proposal arrive as a change of my state.
  const listsKey = useListsKey();
  useEffect(() => {
    void load();
  }, [load, listsKey]);
  const reload = async () => {
    await load();
    await store.refresh().catch(() => {});
  };

  return (
    <Panel title={t("family.title")} onClose={() => store.closePanel()}>
      {failed && !family ? (
        <div className="row spread">
          <p className="form-error">{t("family.error")}</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : !family || !contracts ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <>
          <FamilySection family={family} reload={reload} />
          <ContractsSection contracts={contracts} kin={new Set(family.members.map((m) => m.publicId).filter((x): x is string => !!x))} reload={reload} />
        </>
      )}
    </Panel>
  );
}

const dateText = (ms: number, locale: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(ms);

function Person({ p, children }: { p: PublicProvider; children?: ReactNode }) {
  return (
    <div className="row family-person">
      <Avatar photo={p.photo} icon={p.icon} paint={p.paint} size="sm" fallback={<Initial name={p.nickname} />} />
      <span className="grow">{p.nickname}</span>
      {children}
    </div>
  );
}

function FamilySection({ family, reload }: { family: FamilyView; reload: () => Promise<void> }) {
  const { t, locale } = useI18n();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      try {
        await fn();
      } finally {
        await reload();
      }
    });
  const inFamily = family.members.length > 0;
  const full = family.members.length >= 6;

  return (
    <section className="card stack" data-testid="family">
      <h3 className="with-info">
        {t("family.section")}
        <InfoTip text={t("family.hint")} testId="family" />
      </h3>
      {family.incoming.map((i) => (
        <div key={i.id} className="notice notice-info stack" data-testid="family-incoming">
          <Person p={i.from} />
          <p>{t("family.incoming", { name: i.from.nickname })}</p>
          <div className="row">
            <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => void act(() => store.api.answerInvite(i.id, "join"))} data-testid="family-join">
              {t("family.join")}
            </button>
            <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={() => void act(() => store.api.answerInvite(i.id, "decline"))} data-testid="family-decline">
              {t("family.decline")}
            </button>
          </div>
        </div>
      ))}
      {!inFamily ? (
        <p className="muted small" data-testid="family-none">
          {t("family.none")}
        </p>
      ) : (
        <ul className="plain-list stack" data-testid="family-members">
          {family.members.map((m) => (
            <li key={m.publicId ?? m.nickname}>
              <Person p={m}>
                <small className="muted">{m.me ? t("family.you") : t("family.since", { date: dateText(m.joinedAt, locale) })}</small>
              </Person>
            </li>
          ))}
          {family.members.length === 1 && <li className="muted small">{t("family.alone")}</li>}
        </ul>
      )}
      {family.invites.map((i) => (
        <div key={i.id} className="row spread" data-testid="family-invited">
          <small>{t("family.invited", { name: i.to.nickname, date: dateText(i.expiresAt, locale) })}</small>
          <button type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => void act(() => store.api.withdrawInvite(i.id))}>
            {t("family.withdraw")}
          </button>
        </div>
      ))}
      {inviting ? (
        <InviteForm
          exclude={new Set([...family.members.map((m) => m.publicId), ...family.invites.map((i) => i.to.publicId)].filter((x): x is string => !!x))}
          onCancel={() => setInviting(false)}
          onSend={(publicId) =>
            void act(async () => {
              await store.api.inviteToFamily(publicId);
              setInviting(false);
            })
          }
          busy={busy}
        />
      ) : full ? (
        <p className="muted small">{t("family.full")}</p>
      ) : (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setInviting(true)} data-testid="family-invite">
          {t("family.invite")}
        </button>
      )}
      <InviteNew />
      {inFamily && (
        <button type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => setLeaving(true)} data-testid="family-leave">
          {t("family.leave")}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Confirm
        open={leaving}
        danger
        message={t("family.leaveConfirm")}
        confirmLabel={t("family.leave")}
        onCancel={() => setLeaving(false)}
        onConfirm={() => {
          setLeaving(false);
          void act(() => store.api.leaveFamily());
        }}
      />
    </section>
  );
}

/**
 * 2.8 (FR-301): someone who does not use Siosia yet — a personal link (14 days, once) through the
 * phone's share sheet (Messages, WhatsApp, e-mail…), else copied; after they choose a nickname they
 * get a family invitation from me.
 */
function InviteNew() {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const text = t("inviteNew.shareText", { name: app.profile?.nickname ?? "" });
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false); // the link stays on screen to copy by hand
    }
  };
  const share = async (url: string) => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Siosia", text, url });
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return; // closed the sheet: nothing to do
      }
    }
    await copy(url);
  };
  const create = () =>
    run(async () => {
      const { token, expiresAt } = await store.api.createMemberInvite();
      const url = `${location.origin}${location.pathname}#join=${token}`;
      setLink({ url, expiresAt });
      setCopied(false);
      await share(url);
    });
  return (
    <div className="stack invite-new" data-testid="invite-new">
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void create()} data-testid="invite-new-create">
        <Icon name="share" className="ico-inline" /> {t("inviteNew.button")}
      </button>
      {link && (
        <div className="stack">
          <div className="row">
            <input className="grow" readOnly value={link.url} aria-label={t("inviteNew.link")} onFocus={(e) => e.currentTarget.select()} data-testid="invite-new-url" />
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void share(link.url)} aria-label={t("inviteNew.share")} data-testid="invite-new-share">
              <Icon name="share" />
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void copy(link.url)} aria-label={t("inviteNew.copy")} data-testid="invite-new-copy">
              <Icon name="link" />
            </button>
          </div>
          <small className="muted" data-testid="invite-new-note">
            {copied ? `${t("inviteNew.copied")} · ` : ""}
            {t("inviteNew.valid", { date: dateText(link.expiresAt, locale) })}
          </small>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Pick a member (everyone else with a profile, by nickname) and invite them. */
function InviteForm({ exclude, onSend, onCancel, busy }: { exclude: Set<string>; onSend: (publicId: string) => void; onCancel: () => void; busy: boolean }) {
  const { t } = useI18n();
  const store = useStore();
  const [members, setMembers] = useState<PublicProvider[] | null>(null);
  const [pick, setPick] = useState("");
  useEffect(() => {
    void store.api.members().then(setMembers, () => setMembers([]));
  }, [store]);
  const list = (members ?? []).filter((m) => m.publicId && !exclude.has(m.publicId));
  return (
    <div className="stack" data-testid="family-invite-form">
      {members === null ? (
        <p className="muted">{t("common.loading")}</p>
      ) : list.length === 0 ? (
        <p className="muted small">{t("family.noMembers")}</p>
      ) : (
        <label className="field">
          <span>{t("family.pick")}</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} data-testid="family-pick">
            <option value="">{t("family.pickNone")}</option>
            {list.map((m) => (
              <option key={m.publicId!} value={m.publicId!}>
                {m.nickname}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary grow" disabled={busy || !pick} onClick={() => onSend(pick)} data-testid="family-send">
          {t("family.send")}
        </button>
        <button type="button" className="btn btn-secondary grow" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function ContractsSection({ contracts, kin, reload }: { contracts: ContractView[]; kin: Set<string>; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const [form, setForm] = useState<ContractView | "new" | null>(null);
  const [showPast, setShowPast] = useState(false);
  const live = contracts.filter((c) => c.status === "proposed" || c.status === "active");
  const past = contracts.filter((c) => c.status !== "proposed" && c.status !== "active");
  return (
    <section className="card stack" data-testid="contracts">
      <h3 className="with-info">
        {t("contract.section")}
        <InfoTip text={t("contract.hint")} testId="contracts" />
      </h3>
      {live.length === 0 && form === null && (
        <p className="muted small" data-testid="contracts-none">
          {t("contract.none")}
        </p>
      )}
      {live.map((c) => (
        <ContractCard key={c.id} c={c} reload={reload} onChange={() => setForm(c)} />
      ))}
      {form ? (
        <ContractForm
          from={form === "new" ? null : form}
          kin={kin}
          onDone={async () => {
            setForm(null);
            await reload();
          }}
          onCancel={() => setForm(null)}
        />
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => setForm("new")} data-testid="contract-new">
          {t("contract.new")}
        </button>
      )}
      {past.length > 0 && (
        <>
          <button type="button" className="btn btn-link btn-small" aria-expanded={showPast} onClick={() => setShowPast((x) => !x)}>
            {t("contract.past")} ({past.length})
          </button>
          {showPast && past.map((c) => <ContractCard key={c.id} c={c} reload={reload} />)}
        </>
      )}
    </section>
  );
}

function ContractCard({ c, reload, onChange }: { c: ContractView; reload: () => Promise<void>; onChange?: () => void }) {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [ending, setEnding] = useState(false);
  const services = app.deployment?.services ?? [];
  const act = (fn: () => Promise<unknown>) =>
    run(async () => {
      try {
        await fn();
      } finally {
        await reload();
      }
    });
  const chip = c.status === "active" ? "ok" : c.status === "proposed" ? (c.canAnswer ? "warn" : "info") : "muted";
  return (
    <div className="contract-card stack" data-testid={`contract-${c.status}`}>
      <div className="row spread">
        <strong>{c.side === "family" ? t("contract.provider", { name: c.provider.nickname }) : t("contract.family", { names: c.family.join(", ") || "—" })}</strong>
        <span className={`chip chip-${chip}`}>
          {t(`contract.status.${c.status}` as MessageKey)} · {t("contract.version", { n: c.version })}
        </span>
      </div>
      {c.side === "family" && <small className="muted">{t("contract.family", { names: c.family.join(", ") })}</small>}
      <ul className="plain-list">
        {c.rates.map((r) => {
          const e = services.find((s) => s.id === r.serviceId);
          return (
            <li key={r.serviceId} className="row spread" data-testid="contract-rate">
              <span>
                {e && <EntryIcon icon={e.icon} />} {localText(e?.name, lang) || r.serviceId}
              </span>
              <strong>
                <Money amount={r.perHour} currency={c.currency} />
                <span className="muted small">{t("cost.perHour", { rate: "" })}</span>
              </strong>
            </li>
          );
        })}
      </ul>
      {c.note && <p className="note">„{c.note}”</p>}
      {c.status === "active" && c.answeredAt !== null && <small className="muted">{t("contract.since", { date: dateText(c.answeredAt, locale) })}</small>}
      {c.status === "proposed" && <small className="muted">{c.canAnswer ? t("contract.waitingYou") : t("contract.waitingThem")}</small>}
      {c.status === "proposed" && c.canAnswer && (
        <div className="row">
          <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => void act(() => store.api.answerContract(c.id, "accept"))} data-testid="contract-accept">
            {t("contract.accept")}
          </button>
          <button type="button" className="btn btn-secondary grow" disabled={busy} onClick={() => void act(() => store.api.answerContract(c.id, "decline"))} data-testid="contract-decline">
            {t("contract.decline")}
          </button>
        </div>
      )}
      {c.status === "proposed" && !c.canAnswer && (
        <button type="button" className="btn btn-link btn-small" disabled={busy} onClick={() => void act(() => store.api.withdrawContract(c.id))} data-testid="contract-withdraw">
          {t("contract.withdraw")}
        </button>
      )}
      {c.status === "active" && (
        <div className="row wrap">
          {onChange && c.to && (
            <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={onChange} data-testid="contract-change">
              {t("contract.change")}
            </button>
          )}
          <button type="button" className="btn btn-danger-outline btn-small" disabled={busy} onClick={() => setEnding(true)} data-testid="contract-end">
            {t("contract.end")}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Confirm
        open={ending}
        danger
        message={t("contract.endConfirm")}
        confirmLabel={t("contract.end")}
        onCancel={() => setEnding(false)}
        onConfirm={() => {
          setEnding(false);
          void act(() => store.api.endContract(c.id));
        }}
      />
    </div>
  );
}

/**
 * Propose a contract: as the family or as the one who looks after the kids, with any other member
 * (2.8, FR-300: not only someone who already offers a service — Toria offers none). Lines for the
 * regular services; the YOLO events take the Childcare line (FR-305).
 */
function ContractForm({ from, kin, onDone, onCancel }: { from: ContractView | null; kin: Set<string>; onDone: () => Promise<void>; onCancel: () => void }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [as, setAs] = useState<"family" | "provider">(from?.side ?? "family");
  const [to, setTo] = useState(from?.to ?? "");
  const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries((from?.rates ?? []).map((r) => [r.serviceId, String(r.perHour)])));
  const [note, setNote] = useState(from?.note ?? "");
  const [members, setMembers] = useState<PublicProvider[] | null>(null);
  useEffect(() => {
    void store.api.members().then(setMembers, () => setMembers([]));
  }, [store]);
  const entries = (app.deployment?.services ?? []).filter((e) => e.kind === "time" && e.enabled && !e.section);
  // Everyone else in Siosia but my own family (no contract within a family).
  const people = (members ?? []).filter((p) => p.publicId && !kin.has(p.publicId));
  const lines: ContractRate[] = entries
    .filter((e) => rates[e.id] !== undefined && rates[e.id] !== "")
    .map((e) => ({ serviceId: e.id, perHour: Math.round(Number(rates[e.id].replace(",", ".")) * 100) / 100 }));
  const valid = !!to && lines.length > 0 && lines.every((l) => Number.isFinite(l.perHour) && l.perHour >= 0 && l.perHour <= 10_000);
  const currency = app.deployment?.tariff.currency ?? "";
  const loading = members === null;

  return (
    <div className="stack contract-form" data-testid="contract-form">
      {!from && (
        <fieldset className="field">
          <legend>{t("contract.as")}</legend>
          <div className="row wrap">
            {(["family", "provider"] as const).map((x) => (
              <label key={x} className="switch-row">
                <input
                  type="radio"
                  name="contract-as"
                  checked={as === x}
                  onChange={() => {
                    setAs(x);
                    setTo("");
                    setRates({});
                  }}
                  data-testid={`contract-as-${x}`}
                />
                <span>{t(x === "family" ? "contract.asFamily" : "contract.asProvider")}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {loading ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <label className="field">
          <span>{t(as === "family" ? "contract.withProvider" : "contract.withClient")}</span>
          <select value={to} disabled={!!from} onChange={(e) => (setTo(e.target.value), setRates({}))} data-testid="contract-to">
            <option value="">{t("contract.pickNone")}</option>
            {people.map((p) => (
              <option key={p.publicId!} value={p.publicId!}>
                {p.nickname}
              </option>
            ))}
            {from && to && !people.some((p) => p.publicId === to) && <option value={to}>{from.side === "family" ? from.provider.nickname : from.family[0]}</option>}
          </select>
        </label>
      )}
      {to && entries.length > 0 && (
        <div className="stack" data-testid="contract-lines">
          {entries.map((e) => (
            <div key={e.id} className="row contract-line">
              <label className="switch-row grow">
                <input
                  type="checkbox"
                  checked={rates[e.id] !== undefined}
                  onChange={(ev) =>
                    setRates((r) => {
                      const next = { ...r };
                      if (ev.target.checked) next[e.id] = next[e.id] ?? "";
                      else delete next[e.id];
                      return next;
                    })
                  }
                  data-testid={`contract-pick-${e.id}`}
                />
                <span>
                  <EntryIcon icon={e.icon} /> {localText(e.name, lang)}
                </span>
              </label>
              {rates[e.id] !== undefined && (
                <input
                  className="rate-input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={10000}
                  step="0.01"
                  value={rates[e.id]}
                  aria-label={`${localText(e.name, lang)} — ${t("contract.perHourLabel", { currency })}`}
                  onChange={(ev) => setRates((r) => ({ ...r, [e.id]: ev.target.value }))}
                  data-testid={`contract-rate-${e.id}`}
                />
              )}
            </div>
          ))}
          <small className="muted">{t("contract.perHourLabel", { currency })}</small>
        </div>
      )}
      {to && <p className="muted small">{t("contract.yoloNote")}</p>}
      <label className="field">
        <span>{t("contract.note")}</span>
        <textarea value={note} maxLength={200} rows={2} onChange={(e) => setNote(e.target.value)} data-testid="contract-note" />
      </label>
      {to && !valid && entries.length > 0 && <p className="hint">{t("contract.needLine")}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary grow"
          disabled={busy || !valid}
          onClick={() =>
            void run(async () => {
              await store.api.proposeContract({ to, as, rates: lines, note });
              await onDone();
            })
          }
          data-testid="contract-send"
        >
          {t("contract.send")}
        </button>
        <button type="button" className="btn btn-secondary grow" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
