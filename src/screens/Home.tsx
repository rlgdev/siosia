// S1 Home (2.0, FR-080, FR-083): Siosia (the catalog), Planned (the schedule), History; badges from
// the live state — requests to answer, upcoming items and the next one; the v1 footer.
// 2.1: open requests others made that the user could take (FR-161) badge Siosia, and the Planned
// card says where they are; a driver profile's car icon picks the car's colour (FR-170).

import { AppHint } from "../components/AppInstall";
import { Icon, Logo } from "../components/Icon";
import { NotificationsBell } from "../components/Notifications";
import { Avatar, CarIconButton, ownCarIcon } from "../components/ProfileIcon";
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
  const car = ownCarIcon(app.profile);
  return (
    <main className="home">
      <header className="home-head">
        {car ? (
          <CarIconButton icon={car} />
        ) : (
          // My photo (2.3), else the profile icon, else the logo.
          <Avatar
            photo={app.profile?.photo}
            icon={app.profile?.icon}
            size="md"
            fallback={<Logo />}
          />
        )}
        <div className="home-hello">
          <h1>{t("home.hello", { name: app.profile?.nickname ?? "" })}</h1>
          <p className="muted">{t("start.choose")}</p>
        </div>
        {/* 2.9 (FR-311): Siosia's notifications */}
        <NotificationsBell />
      </header>
      {app.cfg?.backend === "mock" && <p className="notice notice-info">{t("demo.banner")}</p>}
      <AppHint />
      {/* 2.6: a family invitation or a contract proposal waits for my answer */}
      {!!app.my?.familyPending && (
        <button type="button" className="notice notice-info row spread" onClick={() => store.openPanel("family")} data-testid="home-family">
          <span>{app.my.familyPending === 1 ? t("family.noticeOne") : t("family.notice", { n: app.my.familyPending })}</span>
          <Icon name="chevron" />
        </button>
      )}
      {receipt && (
        <button type="button" className="notice notice-info row spread" onClick={() => store.go(receipt)} data-testid="home-receipt">
          <span>{t(receipt === "drive" ? "home.receiptDriver" : "home.receiptRider")}</span>
          <Icon name="chevron" />
        </button>
      )}
      <nav className="mode-cards" aria-label={t("start.nav")}>
        <button type="button" className="mode-card" onClick={() => store.go("catalog")} data-testid="start-siosia">
          <span className="mode-icon mode-icon-siosia" aria-hidden="true">
            <Icon name="users" size={26} />
          </span>
          <span className="mode-title">
            {t("start.siosia")}
            {!!my?.toAnswer && (
              <span className="badge badge-accent" data-testid="badge-answer">
                {t("start.toAnswer", { n: my.toAnswer })}
              </span>
            )}
            {!!my?.openRequests && (
              <span className="badge badge-accent" data-testid="badge-open">
                {t("start.openRequests", { n: my.openRequests })}
              </span>
            )}
          </span>
          <span className="mode-body">{t("start.siosiaBody")}</span>
        </button>
        <button type="button" className="mode-card" onClick={() => store.go("planned")} data-testid="start-planned">
          <span className="mode-icon mode-icon-planned" aria-hidden="true">
            <Icon name="calendar" size={26} />
          </span>
          <span className="mode-title">
            {t("start.planned")}
            {!!my?.planned && (
              <span className="badge" data-testid="badge-planned">
                {my.planned}
              </span>
            )}
            {/* 2.3: unread chat messages across my rooms (the threads are on the items). */}
            {!!my?.unreadChats && (
              <span className="badge badge-accent" data-testid="badge-chat">
                <Icon name="chat" size={14} /> {my.unreadChats === 1 ? t("start.unreadChatsOne") : t("start.unreadChats", { n: my.unreadChats })}
              </span>
            )}
          </span>
          <span className="mode-body">
            <span data-testid="planned-next">
              {next ? t("start.next", { title: next.title, when: whenText(next.at, store.serverNow(), locale, t) }) : t("start.plannedBody")}
            </span>
            {/* Where the open requests are: P1 → You could help. */}
            {!!my?.openRequests && (
              <strong className="mode-hint" data-testid="planned-open">
                {t("start.plannedOpen", { n: my.openRequests })}
              </strong>
            )}
          </span>
        </button>
        <button type="button" className="mode-card" onClick={() => store.go("history")} data-testid="start-history">
          <span className="mode-icon" aria-hidden="true">
            <Icon name="history" size={26} />
          </span>
          <span className="mode-title">{t("start.history")}</span>
          <span className="mode-body">{t("start.historyBody")}</span>
        </button>
        {/* 2.9: My profile is a card like the others; the language and the guide sit below. */}
        <button type="button" className="mode-card" onClick={() => store.openPanel("profile")} data-testid="home-profile">
          <span className="mode-icon mode-icon-profile" aria-hidden="true">
            <Icon name="gear" size={26} />
          </span>
          <span className="mode-title">{t("home.profile")}</span>
          <span className="mode-body">{t("start.profileBody")}</span>
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
      </div>
    </main>
  );
}
