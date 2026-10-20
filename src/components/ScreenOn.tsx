// "Keep the screen on" — this phone's choice, remembered. A checkbox in the top bar of the Ride and
// Drive screens, and the same choice with what it does in ☰ → Siosia as an app.

import { useI18n } from "../i18n";
import { isIOS, isStandalone } from "../services/device";
import { screenWake, useScreenWake } from "../services/wakeLock";
import { Notice } from "./ui";

/**
 * Top bar checkbox. Checked and locked while a driver is online (the screen stays on then anyway).
 * After a launch iOS allows the lock only from a tap: a hint under it asks for one.
 */
export function ScreenOnToggle() {
  const { t } = useI18n();
  const wake = useScreenWake();
  if (!wake.supported) return null;
  const on = wake.checked || wake.forced;
  return (
    <div className="topbar-wake">
      <label className={`topbar-check${on && wake.refused ? " topbar-check-warn" : ""}`}>
        <input
          type="checkbox"
          checked={on}
          disabled={wake.forced}
          // From the tap itself: the phone may only allow the lock then.
          onChange={(e) => void screenWake.setChecked(e.target.checked)}
          data-testid="screen-on"
        />
        <span>{t("wake.title")}</span>
      </label>
      {wake.waiting && (
        <button type="button" className="wake-hint" onClick={() => void screenWake.retry()} data-testid="screen-on-tap">
          {t("wake.tap")}
        </button>
      )}
    </div>
  );
}

/** Profile → Siosia as an app: the checkbox, what it does, and what to do when the phone can't. */
export function ScreenOnSection() {
  const { t } = useI18n();
  const wake = useScreenWake();
  const on = wake.checked || wake.forced;
  return (
    <div className="stack" data-testid="screen-on-section">
      <h4>{t("wake.title")}</h4>
      {wake.supported ? (
        <label className="switch-row">
          <input type="checkbox" checked={on} disabled={wake.forced} onChange={(e) => void screenWake.setChecked(e.target.checked)} />
          <span>{t("wake.checkbox")}</span>
        </label>
      ) : (
        <p className="muted small" data-testid="screen-on-unsupported">
          {/* 18.4 is the Home Screen app's minimum; a Safari tab has it from 16.4. */}
          {isIOS() && isStandalone() ? t("wake.unsupportedIos") : t("wake.unsupported")}
          {isIOS() && !isStandalone() && ` ${t("wake.autoLock")}`}
        </p>
      )}
      {wake.supported && wake.forced && <p className="muted small">{t("wake.online")}</p>}
      {wake.supported && on && wake.refused && <Notice kind="warn">{t("wake.refused")}</Notice>}
      <p className="muted small">{t("wake.help")}</p>
    </div>
  );
}
