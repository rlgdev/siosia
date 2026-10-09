import { useEffect } from "react";
import { OfflineBanner, SharingBanner } from "./components/SharingBanner";
import { I18nProvider } from "./i18n";
import { InviteScreen, Loading, NicknameScreen, Unavailable, Unsupported } from "./screens/Boot";
import { DriverApp } from "./screens/driver/DriverApp";
import { VehiclePanel } from "./screens/driver/VehicleForm";
import { HistoryPanel } from "./screens/History";
import { Home } from "./screens/Home";
import { ProfilePanel } from "./screens/Profile";
import { RiderApp } from "./screens/rider/RiderApp";
import { AppStore, StoreContext, useApp } from "./state/store";

function Screens() {
  const app = useApp();
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
      main = app.mode === "ride" ? <RiderApp /> : app.mode === "drive" ? <DriverApp /> : <Home />;
  }
  return (
    <>
      <SharingBanner />
      {!app.online && <OfflineBanner />}
      {main}
      {app.phase === "ready" && app.panel === "profile" && <ProfilePanel />}
      {app.phase === "ready" && app.panel === "history" && <HistoryPanel earnings={false} />}
      {app.phase === "ready" && app.panel === "earnings" && <HistoryPanel earnings />}
      {app.phase === "ready" && app.panel === "vehicle" && <VehiclePanel />}
    </>
  );
}

function LangRoot() {
  const app = useApp();
  useEffect(() => {
    document.documentElement.lang = app.lang;
  }, [app.lang]);
  return (
    <I18nProvider lang={app.lang}>
      <Screens />
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
