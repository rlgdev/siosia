import { useEffect, useState } from "react";
import type { MessageKey } from "./i18n/en";
import { Launch, launchWanted } from "./components/Launch";
import { OfflineBanner, SharingBanner } from "./components/SharingBanner";
import { applyTheme, watchSystemTheme } from "./services/theme";
import { I18nProvider, useI18n } from "./i18n";
import { InviteScreen, Loading, NicknameScreen, Unavailable, Unsupported } from "./screens/Boot";
import { DriverApp } from "./screens/driver/DriverApp";
import { VehiclePanel } from "./screens/driver/VehicleForm";
import { ChatPanel } from "./components/ChatSheet";
import { AppointmentPanel } from "./screens/Appointment";
import { DriverBookingsPanel } from "./screens/Bookings";
import { Home } from "./screens/Home";
import { Catalog } from "./screens/Catalog";
import { HistoryPanel, HistoryScreen } from "./screens/HistoryScreen";
import { Planned } from "./screens/Planned";
import { RequestPanel } from "./screens/RequestForm";
import { ProfilePanel } from "./screens/Profile";
import { FamilyPanel } from "./screens/Family";
import { ReportPanel } from "./screens/Report";
import { RiderApp } from "./screens/rider/RiderApp";
import { Confirm } from "./components/ui";
import { useRobotSiosia } from "./state/demo";
import { AppStore, StoreContext, useApp, useStore } from "./state/store";

/** A move code on an app that already has a profile: merge only after a clear yes. */
function MoveConfirm() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  return (
    <Confirm
      open={!!app.moveConfirm && app.phase !== "loading"}
      message={app.profile?.nickname ? t("move.confirm", { name: app.profile.nickname }) : t("move.confirmAny")}
      confirmLabel={t("move.confirmYes")}
      onConfirm={() => void store.confirmMove()}
      onCancel={() => store.cancelMove()}
    />
  );
}

/** A master link on a phone that already has a profile: replace it only after a clear yes. */
function MasterConfirm() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const name = app.profile?.nickname;
  return (
    <Confirm
      open={!!app.masterConfirm && app.phase !== "loading"}
      message={name ? t("master.confirmBody", { name }) : t("master.confirmBodyAny")}
      confirmLabel={t("master.confirmYes")}
      onConfirm={() => void store.confirmMaster()}
      onCancel={() => store.cancelMaster()}
    />
  );
}

/** An online driver leaving D1: go offline first, then on to S1 (FR-082) or the screen they asked for. */
export function LeaveDriveConfirm() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  return (
    <Confirm
      open={!!app.leaveDrive}
      message={t("drive.leaveConfirm")}
      confirmLabel={t("drive.leaveYes")}
      onConfirm={() => void store.leaveDriveConfirmed().catch(() => store.cancelLeaveDrive())}
      onCancel={() => store.cancelLeaveDrive()}
    />
  );
}

/** A notification while the app is in front (demo backend). Tap to close — a chat message: to open its thread. */
function PushToast() {
  const app = useApp();
  const store = useStore();
  const p = app.pushToast;
  useEffect(() => {
    if (!p) return;
    const id = setTimeout(() => store.clearPushToast(), 8000);
    return () => clearTimeout(id);
  }, [p, store]);
  if (!p) return null;
  const tap = () => {
    if (p.url) store.openFromUrl(p.url);
    store.clearPushToast();
  };
  return (
    <div className="toast toast-wide push-toast" role="status" data-testid="push-toast" onClick={tap}>
      <strong>{p.title}</strong>
      <span>{p.body}</span>
    </div>
  );
}

/** Says once whether a master-profile link worked. */
function LinkToast() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const n = app.linkNotice;
  const visible = !!n && ((n !== "joined" && n !== "moved") || app.phase === "ready") && app.phase !== "loading";
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => store.clearLinkNotice(), 7000);
    return () => clearTimeout(id);
  }, [visible, store]);
  if (!visible || !n) return null;
  return (
    <div className="toast toast-wide" role="status" data-testid="link-toast" onClick={() => store.clearLinkNotice()}>
      {n === "joined"
        ? t("master.joined", { name: app.profile?.nickname ?? "" })
        : n === "moved"
          ? t("move.done", { name: app.profile?.nickname ?? "" })
          : n === "moved_away"
            ? t("move.away")
        : n === "link_failed"
          ? t("master.failed")
          : t(`err.${n}` as MessageKey)}
    </div>
  );
}

function Screens() {
  const app = useApp();
  useRobotSiosia();
  let main;
  switch (app.phase) {
    case "loading":
      main = <Loading />;
      break;
    case "unsupported":
      main = <Unsupported />;
      break;
    case "unavailable":
      main = <Unavailable />;
      break;
    case "invite":
      main = <InviteScreen />;
      break;
    case "nickname":
      main = <NicknameScreen />;
      break;
    default:
      main =
        app.screen === "ride" ? (
          <RiderApp />
        ) : app.screen === "drive" ? (
          <DriverApp />
        ) : app.screen === "catalog" ? (
          <Catalog />
        ) : app.screen === "planned" ? (
          <Planned />
        ) : app.screen === "history" ? (
          <HistoryScreen />
        ) : (
          <Home />
        );
  }
  return (
    <>
      <SharingBanner />
      {!app.online && <OfflineBanner />}
      {main}
      <LinkToast />
      <PushToast />
      <MasterConfirm />
      <MoveConfirm />
      <LeaveDriveConfirm />
      {app.phase === "ready" && app.panel === "profile" && <ProfilePanel />}
      {app.phase === "ready" && app.panel === "history" && <HistoryPanel />}
      {app.phase === "ready" && app.panel === "vehicle" && <VehiclePanel />}
      {app.phase === "ready" && app.panel === "appointment" && <AppointmentPanel />}
      {app.phase === "ready" && app.panel === "bookings" && <DriverBookingsPanel />}
      {app.phase === "ready" && app.panel === "request" && <RequestPanel />}
      {app.phase === "ready" && app.panel === "chat" && <ChatPanel />}
      {app.phase === "ready" && app.panel === "family" && <FamilyPanel />}
      {app.phase === "ready" && app.panel === "report" && <ReportPanel key={app.panelArg ?? "now"} />}
    </>
  );
}

function LangRoot() {
  const app = useApp();
  // The launch overlay (V52): once per page load, over the boot, gone for good when it ends.
  const [launch, setLaunch] = useState(launchWanted);
  useEffect(() => {
    document.documentElement.lang = app.lang;
  }, [app.lang]);
  // Appearance (V50): the choice on <html> and the meta colour; "system" follows the phone live.
  useEffect(() => {
    applyTheme(app.theme);
    return watchSystemTheme(() => app.theme);
  }, [app.theme]);
  return (
    <I18nProvider lang={app.lang}>
      <Screens />
      {launch && <Launch onDone={() => setLaunch(false)} />}
    </I18nProvider>
  );
}

export function App({ store }: { store: AppStore }) {
  useEffect(() => {
    void store.boot();
    return () => store.dispose();
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <LangRoot />
    </StoreContext.Provider>
  );
}
