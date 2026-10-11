// S1 Home: Ride or Drive, nickname, language, optional sign-in.

import { ProfileIcon } from "../components/ProfileIcon";
import { useI18n } from "../i18n";
import { useApp, useStore } from "../state/store";

export function Home() {
  const { t, lang } = useI18n();
  const app = useApp();
  const store = useStore();
  return (
    <main className="home">
      <header className="home-head">
        {app.profile?.icon ? <ProfileIcon icon={app.profile.icon} size="md" /> : <div className="logo" aria-hidden="true">S</div>}
        <div>
          <h1>{t("home.hello", { name: app.profile?.nickname ?? "" })}</h1>
          <p className="muted">{t("home.choose")}</p>
        </div>
      </header>
      {app.cfg?.backend === "mock" && <p className="notice notice-info">{t("demo.banner")}</p>}
      <div className="mode-cards">
        {app.profile?.masterRole !== "driver" && (
          <button type="button" className="mode-card" onClick={() => store.setMode("ride")} data-testid="mode-ride">
            <span className="mode-icon" aria-hidden="true">📍</span>
            <span className="mode-title">{t("home.ride")}</span>
            <span className="mode-body">{t("home.rideBody")}</span>
          </button>
        )}
        {app.profile?.masterRole !== "rider" && (
          <button type="button" className="mode-card" onClick={() => store.setMode("drive")} data-testid="mode-drive">
            <span className="mode-icon" aria-hidden="true">🚗</span>
            <span className="mode-title">{t("home.drive")}</span>
            <span className="mode-body">{t("home.driveBody")}</span>
          </button>
        )}
      </div>
      <div className="home-foot">
        <label className="field inline">
          <span>{t("home.language")}</span>
          <select value={lang} onChange={(e) => void store.setLang(e.target.value === "pl" ? "pl" : "en")}>
            <option value="en">English</option>
            <option value="pl">Polski</option>
          </select>
        </label>
        <a className="btn btn-link" href="./guide.html">
          {t("home.guide")}
        </a>
        <button type="button" className="btn btn-link" onClick={() => store.openPanel("profile")}>
          {app.cfg?.backend === "supabase" ? t("home.signIn") : t("home.profile")}
        </button>
      </div>
    </main>
  );
}
