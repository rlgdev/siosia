// Boot screens: loading, unsupported browser (NFR-09), backend unavailable (S3, D-04), invite code
// (FR-007) and nickname (FR-002 — the only thing a rider ever has to provide).

import { useState, type FormEvent } from "react";
import { useBusy } from "../components/ui";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

export function Loading() {
  const { t } = useI18n();
  return (
    <main className="center-screen" aria-busy="true">
      <div className="logo" aria-hidden="true">S</div>
      <p>{t("common.loading")}</p>
    </main>
  );
}

export function Unsupported() {
  const { t } = useI18n();
  const app = useApp();
  return (
    <main className="center-screen">
      <div className="logo" aria-hidden="true">S</div>
      <p role="alert">{t("boot.unsupported", { list: app.missing.join(", ") })}</p>
    </main>
  );
}

export function Unavailable() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const demoHref = (() => {
    const u = new URL(location.href);
    u.searchParams.set("backend", "mock");
    return u.toString();
  })();
  return (
    <main className="center-screen">
      <div className="logo" aria-hidden="true">S</div>
      <h1>{t("boot.unavailableTitle")}</h1>
      <p>{t("boot.unavailableBody")}</p>
      {app.cfg?.operatorContact && <p>{t("boot.contact", { contact: app.cfg.operatorContact })}</p>}
      <button type="button" className="btn btn-primary" onClick={() => void store.boot()}>
        {t("common.retry")}
      </button>
      {app.cfg?.demoAllowed && app.cfg.backend !== "mock" && (
        <a className="btn btn-secondary" href={demoHref}>
          {t("boot.tryDemo")}
        </a>
      )}
    </main>
  );
}

export function InviteScreen() {
  const { t } = useI18n();
  const store = useStore();
  const [code, setCode] = useState("");
  const [busy, run, error] = useBusy();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => store.join(code));
  };
  return (
    <main className="center-screen">
      <div className="logo" aria-hidden="true">S</div>
      <h1>{t("invite.title")}</h1>
      <p>{t("invite.body")}</p>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{t("invite.label")}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" required minLength={3} maxLength={40} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || code.trim().length < 3}>
          {t("invite.submit")}
        </button>
      </form>
    </main>
  );
}

export function NicknameScreen() {
  const { t, lang } = useI18n();
  const store = useStore();
  const [name, setName] = useState("");
  const [busy, run, error] = useBusy();
  const valid = name.trim().length >= 2 && name.trim().length <= 20;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) void run(() => store.saveNickname(name.trim()));
  };
  return (
    <main className="center-screen">
      <div className="logo" aria-hidden="true">S</div>
      <h1>{t("nick.title")}</h1>
      <p>{t("nick.body")}</p>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{t("nick.label")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" required />
          <small>{t("nick.hint")}</small>
        </label>
        <label className="field">
          <span>{t("home.language")}</span>
          <select value={lang} onChange={(e) => void store.setLang(e.target.value === "pl" ? "pl" : "en")}>
            <option value="en">English</option>
            <option value="pl">Polski</option>
          </select>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
          {t("common.continue")}
        </button>
      </form>
    </main>
  );
}
