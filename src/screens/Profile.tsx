// S2 Profile: nickname, language, own stats, My place and Services I offer (2.0, FR-140, FR-093),
// links to Planned / History / vehicle, the app and notifications, the account (2.12: sign in with an
// email code or Google, add Google, merge another account here, sign out), privacy, the build.
// 2.3 (FR-200, FR-210): my photo next to the nickname, and My kids.

import { AppSection } from "../components/AppInstall";
import { InfoTip } from "../components/InfoTip";
import { useEffect, useState } from "react";
import type { AccountInfo } from "../backend/types";
import { PlaceInput } from "../components/PlaceInput";
import { PhotoPicker } from "../components/PhotoPicker";
import { Avatar, Initial, MasterChip } from "../components/ProfileIcon";
import { Icon } from "../components/Icon";
import { Confirm, Notice, Panel, RatingBadge, useBusy } from "../components/ui";
import { ACTIVE_STATUSES, type Place } from "../core/types";
import { EntryIcon, localText } from "./Catalog";
import { MyKids } from "./MyKids";
import { AbsorbIssueCard, googleOffered, SignInForm, signInOffered } from "../components/SignIn";
import { useI18n } from "../i18n";
import { isThemePref } from "../services/theme";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  useEffect(() => {
    void store.reloadProfile();
    if (api.account) void api.account().then(setAccount).catch(() => {});
  }, [api, store]);
  // Opened from the start screen's "Sign in…" notice: straight to the Account card.
  const toAccount = app.panelArg === "account" && !!account;
  useEffect(() => {
    if (toAccount) document.querySelector("[data-testid=profile-account]")?.scrollIntoView?.({ block: "start" });
  }, [toAccount]);

  const p = app.profile;
  // The server refuses a deletion during a ride (active_ride): say so instead of offering it (C2).
  const rideOn = !!app.my?.ride && ACTIVE_STATUSES.includes(app.my.ride.status);

  return (
    <Panel title={t("profile.title")} onClose={() => store.closePanel()}>
      <section className="card stack">
        {p && (
          <PhotoPicker target={{ kind: "profile" }} current={p.photo} onChanged={() => store.reloadProfile()} testId="profile-photo">
            <Avatar photo={p.photo} icon={p.masterId ? null : p.icon} size="md" fallback={<Initial name={p.nickname} />} />
            <span className="with-info grow">
              {t("photo.yours")}
              <InfoTip text={t("photo.hint")} testId="profile-photo" />
            </span>
          </PhotoPicker>
        )}
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
        {/* Appearance (2.4, V50): this phone's choice; "Same as the phone" follows the system setting. */}
        <label className="field">
          <span>{t("profile.appearance")}</span>
          <select value={app.theme} onChange={(e) => store.setTheme(isThemePref(e.target.value) ? e.target.value : "system")} data-testid="appearance">
            <option value="system">{t("profile.appearanceSystem")}</option>
            <option value="light">{t("profile.appearanceLight")}</option>
            <option value="dark">{t("profile.appearanceDark")}</option>
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
      {p && <MyKids />}
      {p && (
        // 2.9: a card like the others — the app's font and colour, the heading's size, the family icon.
        <button type="button" className="card row spread profile-link" onClick={() => store.openPanel("family")} data-testid="profile-family">
          <span className="profile-link-title">
            <Icon name="family" size={22} />
            {t("family.title")}
          </span>
          <Icon name="chevron" />
        </button>
      )}

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

      <section className="card stack" data-testid="profile-account">
        <h3>{t("profile.account")}</h3>
        <AbsorbIssueCard />
        {!api.sendCode ? (
          <p className="muted">{t("profile.accountsDemo")}</p>
        ) : !account ? null : account.isAnonymous && !signInOffered(app.deployment) ? (
          <p className="muted">{t("signin.notReady")}</p>
        ) : account.isAnonymous ? (
          <>
            <p>
              <strong>{t("signin.keepTitle")}</strong>
            </p>
            <p className="muted">{t("signin.keepBody")}</p>
            {rideOn && <p className="muted small">{t("signin.afterRide")}</p>}
            <SignInForm disabled={rideOn} testId="keep" />
          </>
        ) : (
          <>
            {account.email && <p data-testid="profile-signed-in">{t("profile.signedInAs", { email: account.email })}</p>}
            <p className="muted small">
              {t("profile.providers", {
                list: account.providers.map((x) => (x === "google" ? "Google" : x === "email" ? t("profile.providerEmail") : x)).join(", ")
              })}
            </p>
            {api.linkGoogle && googleOffered(app.deployment?.googleSignIn) && !account.providers.includes("google") && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => store.linkGoogle())}>
                {t("profile.addGoogle")}
              </button>
            )}
            <MergeAccount />
            <button type="button" className="btn btn-secondary" disabled={busy || rideOn} onClick={() => setConfirmSignOut(true)} data-testid="profile-sign-out">
              {t("profile.signOut")}
            </button>
            {rideOn && <p className="muted small">{t("profile.signOutRide")}</p>}
          </>
        )}
      </section>
      <Confirm
        open={confirmSignOut}
        message={t("profile.signOutConfirm")}
        confirmLabel={t("profile.signOut")}
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => {
          setConfirmSignOut(false);
          void run(() => store.signOut());
        }}
      />

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
        <button type="button" className="btn btn-danger-outline" disabled={rideOn} onClick={() => setConfirmDelete(true)} data-testid="profile-delete">
          {t("profile.delete")}
        </button>
        {rideOn && (
          <p className="muted small" data-testid="profile-delete-ride">
            {t("profile.deleteRide")}
          </p>
        )}
      </section>
      <Confirm
        open={confirmDelete}
        danger
        message={account && !account.isAnonymous ? `${t("profile.deleteConfirm")} ${t("profile.deleteNote")}` : t("profile.deleteConfirm")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void run(() => store.deleteProfile());
        }}
      />
      <p className="muted small center-text" data-testid="profile-build">
        {t("profile.build", { id: __SIOSIA_BUILD__ })}
      </p>
    </Panel>
  );
}

/**
 * 2.12 (FR-327): another account of mine (say, Google with a different address) joins this one —
 * its code comes from that account's ☰ → Siosia as an app → Show code. Whose account it is shows
 * first; nothing joins before a clear yes (a code from someone else must not slip in).
 */
function MergeAccount() {
  const { t } = useI18n();
  const store = useStore();
  const [code, setCode] = useState("");
  const [busy, run, error] = useBusy();
  const [done, setDone] = useState(false);
  const [other, setOther] = useState<{ nickname: string; publicId: string | null } | null>(null);
  const ready = code.replace(/[^A-Za-z0-9]/g, "").length === 8;
  return (
    <details className="merge-account">
      <summary>{t("profile.mergeTitle")}</summary>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setDone(false);
            setOther(await store.previewMerge(code));
          });
        }}
      >
        <p className="muted small">{t("profile.mergeBody")}</p>
        <label className="field">
          <span>{t("profile.mergeLabel")}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            data-testid="merge-code"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {done && <Notice kind="ok">{t("profile.mergeDone")}</Notice>}
        <button type="submit" className="btn btn-secondary" disabled={busy || !ready}>
          {t("profile.mergeSubmit")}
        </button>
      </form>
      <Confirm
        open={!!other}
        message={t("profile.mergeConfirm", { name: other?.nickname ?? "", publicId: other?.publicId ?? "—" })}
        confirmLabel={t("profile.mergeYes")}
        onCancel={() => setOther(null)}
        onConfirm={() => {
          setOther(null);
          void run(async () => {
            await store.mergeAccount(code);
            setCode("");
            setDone(true);
          });
        }}
      />
    </details>
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
