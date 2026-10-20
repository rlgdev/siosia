// S1 Home (2.0, FR-080, FR-083): Siosia (the catalog), Planned (the schedule), History; badges from
// the live state — requests to answer, upcoming items and the next one; the v1 footer.

import { AppHint } from "../components/AppInstall";
import { ProfileIcon } from "../components/ProfileIcon";
import { whenText } from "../components/when";
import { useI18n } from "../i18n";
import { readPref } from "../services/device";
import { useApp, useStore, type AppSnapshot, type Screen } from "../state/store";

/**
 * A finished ride still waiting for Mark as paid / rating (§12) and the screen whose R4/D4 shows it.
 * The app reopens on S1 (FR-082), so S1 points there; Done on R4/D4 dismisses it for good (the
 * same per-user lists as RiderApp / DriverApp).
 */
export function receiptTarget(app: AppSnapshot): Screen | null {
  const r = app.my?.pendingReceipt;
  if (!r || app.my?.ride) return null;
  const role = app.profile?.masterRole ?? null;
  const driver = r.role === "driver";
  if (driver ? role === "rider" || !app.vehicle : role === "driver") return null;
  const dismissed = readPref<string[]>(`${driver ? "dismissedSummaries" : "dismissedReceipts"}.${app.uid}`, []);
  if (dismissed.includes(r.id)) return null;
  return driver ? "drive" : "ride";
}

export function Home() {
  const { t, lang, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const my = app.my;
  const next = my?.nextPlanned ?? null;
  const receipt = receiptTarget(app);
  return (
    <main className="home">
      <header className="home-head">
        {app.profile?.icon ? <ProfileIcon icon={app.profile.icon} size="md" /> : <div className="logo" aria-hidden="true">S</div>}
        <div>
          <h1>{t("home.hello", { name: app.profile?.nickname ?? "" })}</h1>
          <p className="muted">{t("start.choose")}</p>
        </div>
      </header>
      {app.cfg?.backend === "mock" && <p className="notice notice-info">{t("demo.banner")}</p>}
      <AppHint />
      {receipt && (
        <button type="button" className="notice notice-info row spread" onClick={() => store.go(receipt)} data-testid="home-receipt">
          <span>{t(receipt === "drive" ? "home.receiptDriver" : "home.receiptRider")}</span>
          <span aria-hidden="true">→</span>
        </button>
      )}
      <nav className="mode-cards" aria-label={t("start.nav")}>
        <button type="button" className="mode-card" onClick={() => store.go("catalog")} data-testid="start-siosia">
          <span className="mode-icon" aria-hidden="true">🤝</span>
          <span className="mode-title">
            {t("start.siosia")}
            {!!my?.toAnswer && (
              <span className="badge badge-accent" data-testid="badge-answer">
                {t("start.toAnswer", { n: my.toAnswer })}
              </span>
            )}
          </span>
          <span className="mode-body">{t("start.siosiaBody")}</span>
        </button>
        <button type="button" className="mode-card" onClick={() => store.go("planned")} data-testid="start-planned">
          <span className="mode-icon" aria-hidden="true">📅</span>
          <span className="mode-title">
            {t("start.planned")}
            {!!my?.planned && (
              <span className="badge" data-testid="badge-planned">
                {my.planned}
              </span>
            )}
          </span>
          <span className="mode-body" data-testid="planned-next">
            {next ? t("start.next", { title: next.title, when: whenText(next.at, store.serverNow(), locale, t) }) : t("start.plannedBody")}
          </span>
        </button>
        <button type="button" className="mode-card" onClick={() => store.go("history")} data-testid="start-history">
          <span className="mode-icon" aria-hidden="true">🕘</span>
          <span className="mode-title">{t("start.history")}</span>
          <span className="mode-body">{t("start.historyBody")}</span>
        </button>
      </nav>
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
