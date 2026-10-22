// S2 Profile: nickname, language, own stats, My place and Services I offer (2.0, FR-140, FR-093),
// links to Planned / History / vehicle, the app and notifications, account linking (US8), privacy.

import { AppSection } from "../components/AppInstall";
import { InfoTip } from "../components/InfoTip";
import { useEffect, useState } from "react";
import type { AccountInfo } from "../backend/types";
import { PlaceInput } from "../components/PlaceInput";
import { MasterChip } from "../components/ProfileIcon";
import { Confirm, Notice, Panel, RatingBadge, useBusy } from "../components/ui";
import type { Place } from "../core/types";
import { EntryIcon, localText } from "./Catalog";
import { useI18n } from "../i18n";
import { resetDemo } from "../state/demo";
import { useApp, useStore } from "../state/store";

export function ProfilePanel() {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const api = store.api;
  const [name, setName] = useState(app.profile?.nickname ?? "");
  const [busy, run, error] = useBusy();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void store.reloadProfile();
    if (api.account) void api.account().then(setAccount).catch(() => {});
  }, [api, store]);

  const p = app.profile;

  return (
    <Panel title={t("profile.title")} onClose={() => store.closePanel()}>
      <section className="card stack">
        {p?.masterId ? (
          <>
            <MasterChip />
            <p className="muted small">{t("master.nicknameFixed")}</p>
          </>
        ) : (
          <label className="field">
            <span>{t("profile.nickname")}</span>
            <div className="row">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || name.trim() === p?.nickname || name.trim().length < 2}
                onClick={() => void run(() => store.saveNickname(name.trim()))}
              >
                {t("common.save")}
              </button>
            </div>
          </label>
        )}
        <label className="field">
          <span>{t("profile.language")}</span>
          <select value={lang} onChange={(e) => void store.setLang(e.target.value === "pl" ? "pl" : "en")}>
            <option value="en">English</option>
            <option value="pl">Polski</option>
          </select>
        </label>
        {p && (
          <div className="kv">
            <span>{t("profile.rating")}</span>
            <RatingBadge rating={p.rating} />
          </div>
        )}
        {p && (
          <div className="kv">
            <span>{t("profile.cancels")}</span>
            <span>{t("profile.cancelsBody", { r: p.riderCancels, l: p.lateCancels, d: p.driverCancels })}</span>
          </div>
        )}
      </section>

      {p && <MyPlace key={p.home ? `${p.home.lat},${p.home.lng},${p.home.label}` : "none"} />}
      {p && !p.offersPreset && <ServicesIOffer />}

      <AppSection />

      <section className="card stack">
        <div className="row wrap">
          <button type="button" className="btn btn-link" onClick={() => store.goFromPanel("planned")} data-testid="profile-planned">
            {t("start.planned")}
          </button>
          <button type="button" className="btn btn-link" onClick={() => store.goFromPanel("history")} data-testid="profile-history">
            {t("start.history")}
          </button>
          {(app.vehicle || (app.profile?.masterRole !== "rider" && app.screen === "drive")) && (
            <button type="button" className="btn btn-link" onClick={() => store.openPanel("vehicle")}>
              {app.vehicle ? `${t("profile.editVehicle")} (${app.vehicle.plate})` : t("profile.vehicle")}
            </button>
          )}
        </div>
      </section>

      <section className="card stack">
        <h3>{t("profile.account")}</h3>
        {!api.account ? (
          <p className="muted">{t("profile.accountsDemo")}</p>
        ) : (
          <>
            <p className="muted">
              {account && !account.isAnonymous && account.email ? t("profile.signedInAs", { email: account.email }) : t("profile.anonymous")}
            </p>
            {sent && <Notice kind="ok">{t("profile.emailSent", { email: sent })}</Notice>}
            {(!account || account.isAnonymous) && (
              <>
                <label className="field">
                  <span>{t("profile.email")}</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
                </label>
                <div className="row wrap">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !email.includes("@")}
                    onClick={() => void run(async () => (await api.linkEmail?.(email), setSent(email)))}
                  >
                    {t("profile.linkEmail")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !email.includes("@")}
                    onClick={() => void run(async () => (await api.signInWithEmail?.(email), setSent(email)))}
                  >
                    {t("profile.signInEmail")}
                  </button>
                </div>
                <div className="row wrap">
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api.linkGoogle!())}>
                    {t("profile.linkGoogle")}
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api.signInWithGoogle!())}>
                    {t("profile.signInGoogle")}
                  </button>
                </div>
              </>
            )}
            {account && !account.isAnonymous && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void run(async () => {
                    await api.signOut?.();
                    location.reload();
                  })
                }
              >
                {t("profile.signOut")}
              </button>
            )}
          </>
        )}
      </section>

      <section className="card stack">
        <h3 className="with-info">
          {t("profile.privacyTitle")}
          <InfoTip text={t("profile.privacy")} testId="privacy" />
        </h3>
      </section>

      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="stack">
        {app.cfg?.backend === "mock" && (
          <button type="button" className="btn btn-secondary" onClick={() => void resetDemo()}>
            {t("demo.reset")}
          </button>
        )}
        <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>
          {t("profile.delete")}
        </button>
      </section>
      <Confirm
        open={confirmDelete}
        danger
        message={t("profile.deleteConfirm")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void run(() => store.deleteProfile());
        }}
      />
    </Panel>
  );
}

/** My place (FR-140): where requests start and the default pickup of rides to appointments. */
function MyPlace() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const saved = app.profile?.home ?? null;
  const [place, setPlace] = useState<Place | null>(saved);
  const [name, setName] = useState(saved?.label ?? "");
  const [busy, run, error] = useBusy();
  const label = name.trim() || place?.label || "";
  const changed = !!place && (place.lat !== saved?.lat || place.lng !== saved?.lng || label !== saved?.label);
  const save = (next: Place | null) =>
    run(async () => {
      await store.api.saveHome(next);
      await store.reloadProfile();
    });
  return (
    <section className="card stack" data-testid="my-place">
      <h3 className="with-info">
        {t("place.myPlace")}
        <InfoTip text={t("profile.myPlaceHint")} testId="my-place" />
      </h3>
      <PlaceInput
        label={t("profile.myPlaceWhere")}
        value={place}
        onChange={(v) => {
          setPlace(v);
          setName(v?.label ?? "");
        }}
        testId="my-place-input"
      />
      {place && (
        <label className="field">
          <span>{t("profile.myPlaceName")}</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="my-place-name" />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="button" className="btn btn-primary" disabled={busy || !changed || !label} onClick={() => void save({ ...place!, label })} data-testid="my-place-save">
          {t("common.save")}
        </button>
        {saved && (
          <button type="button" className="btn btn-link" disabled={busy} onClick={() => void save(null)} data-testid="my-place-clear">
            {t("place.clear")}
          </button>
        )}
      </div>
    </section>
  );
}

/** Services I offer (FR-093): one toggle per "time" entry; a master profile's preset hides them. */
function ServicesIOffer() {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const entries = (app.deployment?.services ?? []).filter((e) => e.kind === "time" && e.enabled);
  const saved = app.profile?.offers ?? [];
  // The tick follows the tap at once; a refused change goes back to what the server has.
  const [offers, setOffers] = useState<string[]>(saved);
  if (!entries.length) return null;
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...offers, id] : offers.filter((x) => x !== id);
    setOffers(next);
    void run(async () => {
      try {
        await store.api.setOffers(next);
      } catch (e) {
        setOffers(saved);
        throw e;
      }
      await store.reloadProfile();
    });
  };
  return (
    <section className="card stack" data-testid="offers">
      <h3 className="with-info">
        {t("profile.offersTitle")}
        <InfoTip text={`${t("profile.offersHint")} ${t("profile.offersRide")}`} testId="offers" />
      </h3>
      {entries.map((e) => (
        <label key={e.id} className="switch-row">
          <input type="checkbox" checked={offers.includes(e.id)} disabled={busy} onChange={(ev) => toggle(e.id, ev.target.checked)} data-testid={`offer-${e.id}`} />
          <span>
            <EntryIcon icon={e.icon} /> {localText(e.name, lang)}
          </span>
        </label>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
