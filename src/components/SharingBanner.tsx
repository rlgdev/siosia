// S4: persistent banner whenever this device is sending its position, with a one-tap stop (FR-041).
// Its height is published as --banner-h so the top bar and full-screen panels sit below it.

import { useEffect, useRef, useState } from "react";
import { errorMessage, useI18n } from "../i18n";
import { useSharing } from "../state/sharing";

export function SharingBanner() {
  const { t } = useI18n();
  const entries = useSharing();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const visible = entries.length > 0;

  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!visible || !el) {
      root.style.removeProperty("--banner-h");
      return;
    }
    const apply = () => root.style.setProperty("--banner-h", `${el.offsetHeight}px`);
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty("--banner-h");
    };
  }, [visible, error]);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error]);

  if (!visible) return null;
  const e = entries[0];
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const x of entries) await x.stop();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sharing-banner" role="status" data-testid="sharing-banner" ref={ref}>
      <span className="live-dot" aria-hidden="true" />
      <span className="sharing-text">
        {t("sharing.title")} · {t(e.role === "driver" ? "sharing.driver" : "sharing.rider")}
        {error && (
          <span className="sharing-error" role="alert">
            {error}
          </span>
        )}
      </span>
      <button type="button" className="btn btn-small btn-light" disabled={busy} onClick={() => void stop()}>
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
