// "Siosia as an app". On iOS a Home Screen app has its own storage — it does not see the browser's
// session — so a one-time code moves the profile (with its history, vehicle and master link) into
// the app. The same code moves a profile to another phone.

import { useEffect, useState, type FormEvent } from "react";
import { disablePush, enablePush, pushState, type PushState } from "../services/push";
import { useI18n } from "../i18n";
import { isIOS, isStandalone, readPref, writePref } from "../services/device";
import { useApp, useStore } from "../state/store";
import { Notice, useBusy } from "./ui";

/** Profile panel section: install steps, the move code and (inside the app) its status. */
export function AppSection() {
  const { t, locale } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run, error] = useBusy();
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const ios = isIOS();
  const until = code ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(code.expiresAt - app.clockOffset) : "";
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
    } catch {
      /* the code stays visible to type */
    }
  };
  return (
    <section className="card stack" data-testid="app-section">
      <h3>{t("app.title")}</h3>
      {isStandalone() ? (
        <p>{t("app.installed")}</p>
      ) : (
        <ol className="steps">
          <li>{t(ios ? "app.ios1" : "app.other1")}</li>
          <li>{t(ios ? "app.ios2" : "app.other2")}</li>
          <li>{t("app.step3")}</li>
        </ol>
      )}
      <p className="muted small">{t("app.codeIntro")}</p>
      {code ? (
        <div className="transfer-code">
          <strong data-testid="transfer-code">{code.code}</strong>
          <span className="muted small">{t("app.codeUntil", { time: until })}</span>
          <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
            {t(copied ? "app.copied" : "app.copy")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void run(async () => setCode(await store.api.createTransfer()))}
          data-testid="show-transfer-code"
        >
          {t("app.showCode")}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Notifications />
      <MoveHere />
    </section>
  );
}

function usePush(): [PushState | null, () => Promise<void>, () => Promise<void>] {
  const app = useApp();
  const store = useStore();
  const [state, setState] = useState<PushState | null>(null);
  const key = app.cfg?.vapidPublicKey ?? "";
  useEffect(() => {
    void pushState(store.api, key).then(setState, () => setState("unsupported"));
  }, [store, key]);
  return [
    state,
    async () => setState(await enablePush(store.api, key)),
    async () => setState(await disablePush(store.api))
  ];
}

const PUSH_TEXT: Record<PushState, "push.needsApp" | "push.unsupported" | "push.notConfigured" | "push.blocked" | "push.off" | "push.on"> = {
  "needs-app": "push.needsApp",
  unsupported: "push.unsupported",
  "not-configured": "push.notConfigured",
  blocked: "push.blocked",
  off: "push.off",
  on: "push.on"
};

/** Notifications for this phone: what they are for, and on / off. */
function Notifications() {
  const { t } = useI18n();
  const [state, enable, disable] = usePush();
  const [busy, run, error] = useBusy();
  if (!state) return null;
  return (
    <div className="stack" data-testid="push-section">
      <h4>{t("push.title")}</h4>
      <p className="muted small" data-testid="push-state">
        {t(PUSH_TEXT[state])}
      </p>
      {state === "off" && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(enable)} data-testid="push-enable">
          {t("push.enable")}
        </button>
      )}
      {state === "on" && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(disable)} data-testid="push-disable">
          {t("push.disable")}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Ride / Drive sheets: one tap to turn notifications on where they can work (not dismissed). */
export function PushPrompt() {
  const { t } = useI18n();
  const [state, enable] = usePush();
  const [busy, run] = useBusy();
  const [hidden, setHidden] = useState(() => readPref<boolean>("pushPrompt.dismissed", false));
  if (hidden || state !== "off") return null;
  return (
    <Notice kind="info">
      <span>🔔 {t("push.prompt")}</span>{" "}
      <button type="button" className="btn btn-link" disabled={busy} onClick={() => void run(enable)} data-testid="push-prompt-enable">
        {t("push.enable")}
      </button>
      <button
        type="button"
        className="btn btn-link"
        aria-label={t("common.close")}
        onClick={() => {
          writePref("pushPrompt.dismissed", true);
          setHidden(true);
        }}
      >
        ×
      </button>
    </Notice>
  );
}

/** Start screens: take over a profile with a move code (or a profile link). Open by default in the app. */
export function MoveHere() {
  const { t } = useI18n();
  const store = useStore();
  const [code, setCode] = useState("");
  const [busy, run, error] = useBusy();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => store.redeemCode(code));
  };
  return (
    <details className="move-here" open={isStandalone()}>
      <summary>{t("move.title")}</summary>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">{t("move.body")}</p>
        <label className="field">
          <span>{t("move.label")}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            data-testid="move-code"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || code.trim().length < 8} data-testid="move-submit">
          {t("move.submit")}
        </button>
      </form>
    </details>
  );
}

/** iPhone in a browser tab: suggest the Home Screen app (notifications only work there). */
export function AppHint() {
  const { t } = useI18n();
  const store = useStore();
  const [hidden, setHidden] = useState(() => readPref<boolean>("appHint.dismissed", false));
  if (hidden || !isIOS() || isStandalone()) return null;
  return (
    <Notice kind="info">
      <span>📲 {t("app.hint")}</span>{" "}
      <button type="button" className="btn btn-link" onClick={() => store.openPanel("profile")} data-testid="app-hint-how">
        {t("app.how")}
      </button>
      <button
        type="button"
        className="btn btn-link"
        aria-label={t("common.close")}
        onClick={() => {
          writePref("appHint.dismissed", true);
          setHidden(true);
        }}
      >
        ×
      </button>
    </Notice>
  );
}
