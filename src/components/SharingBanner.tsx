// S4: persistent banner whenever this device is sending its position, with a one-tap stop (FR-041).

import { useI18n } from "../i18n";
import { useSharing } from "../state/sharing";

export function SharingBanner() {
  const { t } = useI18n();
  const entries = useSharing();
  if (!entries.length) return null;
  const e = entries[0];
  return (
    <div className="sharing-banner" role="status" data-testid="sharing-banner">
      <span className="live-dot" aria-hidden="true" />
      <span className="sharing-text">
        {t("sharing.title")} · {t(e.role === "driver" ? "sharing.driver" : "sharing.rider")}
      </span>
      <button type="button" className="btn btn-small btn-light" onClick={() => entries.forEach((x) => x.stop())}>
        {t("sharing.stop")}
      </button>
    </div>
  );
}

export function OfflineBanner() {
  const { t } = useI18n();
  return (
    <div className="offline-banner" role="alert">
      {t("common.offline")}
    </div>
  );
}
