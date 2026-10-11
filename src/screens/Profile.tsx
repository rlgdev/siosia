// S2 Profile: nickname, language, account linking (US8), vehicle, switch mode, own stats, privacy.

import { AppSection } from "../components/AppInstall";
import { useEffect, useState } from "react";
import type { AccountInfo } from "../backend/types";
import { MasterChip } from "../components/ProfileIcon";
import { Confirm, Notice, Panel, RatingBadge, useBusy } from "../components/ui";
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
  const [blocked, setBlocked] = useState<"driver" | "rider" | null>(null);

  useEffect(() => {
    void store.reloadProfile();
    if (api.account) void api.account().then(setAccount).catch(() => {});
  }, [api, store]);

  const my = app.my;
  const p = app.profile;

  const switchTo = (mode: "ride" | "drive") => {
    if (app.mode === "drive" && (my?.driverOnline || (my?.ride && my.ride.role === "driver"))) return setBlocked("driver");
    if (app.mode === "ride" && my?.ride && my.ride.role === "rider") return setBlocked("rider");
    store.setMode(mode);
  };

  const resolveBlock = () =>
    run(async () => {
      if (blocked === "driver") await api.setOnline(false);
      if (blocked === "rider" && my?.ride) await api.cancelRide(my.ride.id);
      await store.refresh();
      setBlocked(null);
    });

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

      <AppSection />

      <section className="card stack">
        <h3>{t("profile.mode")}</h3>
        {blocked && (
          <Notice kind="warn">
            <p>{t(blocked === "driver" ? "switch.driverFirst" : "switch.riderFirst")}</p>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void resolveBlock()}>
              {t(blocked === "driver" ? "switch.goOffline" : "switch.cancelRequest")}
            </button>
          </Notice>
        )}
        <div className="row">
          {app.mode !== "ride" && !p?.masterRole && (
            <button type="button" className="btn btn-secondary" onClick={() => switchTo("ride")}>
              {t("profile.toRide")}
            </button>
          )}
          {app.mode !== "drive" && !p?.masterRole && (
            <button type="button" className="btn btn-secondary" onClick={() => switchTo("drive")}>
              {t("profile.toDrive")}
            </button>
          )}
        </div>
        <div className="row">
          <button type="button" className="btn btn-link" onClick={() => store.openPanel(app.mode === "drive" ? "earnings" : "history")}>
            {t(app.mode === "drive" ? "profile.earnings" : "profile.history")}
          </button>
          {app.mode && (
            <button type="button" className="btn btn-link" onClick={() => store.openPanel("bookings")} data-testid="profile-bookings">
              {t("profile.bookings")}
            </button>
          )}
          {(app.mode === "drive" || app.vehicle) && (
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
        <h3>{t("profile.privacyTitle")}</h3>
        <p className="muted">{t("profile.privacy")}</p>
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
