// 2.12 accounts (FR-326, FR-327): signing in with an email code or Google, the same form on the
// sign-in screen and in Profile → Account ("Keep my account"). The email step sends a 6-digit code
// (never a link: an iPhone opens links from Mail in Safari, not in the Home Screen app); the code is
// typed here and the page reloads as the signed-in account, which then takes in the account this
// phone used before. Google leaves for Google and comes back the same way.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DeploymentConfig, GoogleSignIn } from "../core/types";
import { ServerError } from "../core/types";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { isIOS, isStandalone } from "../services/device";
import { keepSentEmail, readAbsorb, readSent, readSentEmail, useApp, useStore } from "../state/store";
import { Notice, useBusy } from "./ui";

const RESEND_S = 60;

/** Whether this phone is offered "Continue with Google" (the operator's choice per platform). */
export function googleOffered(mode: GoogleSignIn | undefined): boolean {
  if (!mode || mode === "off") return false;
  if (mode === "no_standalone") return !isStandalone();
  if (mode === "no_ios") return !isIOS();
  return true;
}

/** Whether this phone is offered any way to sign in (the operator switches each on once it works). */
export function signInOffered(d: DeploymentConfig | null | undefined): boolean {
  return !!d && (!!d.emailSignIn || googleOffered(d.googleSignIn));
}

/** Words kept as "key|key" (a reason and an advice): each translated, joined by a space. */
export function wordsOf(t: (k: MessageKey) => string, keys: string | null): string {
  return (keys ?? "")
    .split("|")
    .filter(Boolean)
    .map((k) => t(k as MessageKey))
    .join(" ");
}

const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export function SignInForm({ disabled = false, testId = "signin" }: { disabled?: boolean; testId?: string }) {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const api = store.api;
  // A code sent from this phone in the last 30 minutes (the app may have been closed to read the mail).
  const [sentTo, setSentTo] = useState<string | null>(() => readSentEmail());
  const [email, setEmail] = useState(() => readSentEmail() ?? "");
  const [code, setCode] = useState("");
  // Resend waits a minute from the last code, also after the app was closed and opened again.
  const [wait, setWait] = useState(() => {
    const s = readSent();
    return s ? Math.max(0, Math.ceil(RESEND_S - (Date.now() - s.at) / 1000)) : 0;
  });
  const [busy, run, error, setError] = useBusy();
  const tried = useRef<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  if (!api.sendCode) return <p className="muted">{t("profile.accountsDemo")}</p>;
  const byEmail = !!app.deployment?.emailSignIn;
  const google = googleOffered(app.deployment?.googleSignIn) && !!api.signInWithGoogle;
  if (!byEmail && !google) return <p className="muted">{t("signin.notReady")}</p>;

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!validEmail(email)) return;
    const to = email.trim().toLowerCase();
    void run(async () => {
      try {
        await store.sendCode(to);
      } catch (err) {
        // Too soon for another mail: a code sent a moment ago still works — let it be typed.
        if (err instanceof ServerError && (err.code === "rate_limited" || err.code === "code_wait") && readSentEmail() === to) {
          setSentTo(to);
          if (err.code === "code_wait") setWait(Number(err.message) || RESEND_S);
        }
        throw err;
      }
      keepSentEmail(to);
      setSentTo(to);
      setCode("");
      tried.current = null;
      setWait(RESEND_S);
    });
  };
  const verify = (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (!sentTo || digits.length !== 6 || tried.current === digits) return;
    tried.current = digits;
    void run(() => store.verifyCode(sentTo, digits));
  };
  const otherEmail = () => {
    keepSentEmail(null);
    setSentTo(null);
    setCode("");
    setError(null);
  };

  if (sentTo)
    return (
      <form
        className="stack"
        data-testid={`${testId}-code-step`}
        onSubmit={(e) => {
          e.preventDefault();
          tried.current = null;
          verify(code);
        }}
      >
        <h3>{t("signin.codeTitle")}</h3>
        <p>{t("signin.codeBody", { email: sentTo })}</p>
        <label className="field">
          <span>{t("signin.code")}</span>
          <input
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(v);
              if (v.length === 6) verify(v);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            className="code-input"
            data-testid={`${testId}-code`}
            disabled={disabled}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || disabled || code.length !== 6}>
          {t("signin.verify")}
        </button>
        <p className="muted small">{t("signin.checkSpam")}</p>
        <div className="row wrap">
          <button type="button" className="btn btn-link" disabled={busy || disabled || wait > 0} onClick={() => send()}>
            {wait > 0 ? t("signin.resendIn", { s: wait }) : t("signin.resend")}
          </button>
          <button type="button" className="btn btn-link" disabled={busy} onClick={otherEmail}>
            {t("signin.otherEmail")}
          </button>
        </div>
      </form>
    );

  return (
    <div className="stack" data-testid={`${testId}-email-step`}>
      {byEmail && (
        <form className="stack" onSubmit={send}>
          <label className="field">
            <span>{t("signin.email")}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={`${testId}-email`}
              disabled={disabled}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || disabled || !validEmail(email)} data-testid={`${testId}-send`}>
            {t("signin.sendCode")}
          </button>
        </form>
      )}
      {google && (
        <>
          {byEmail && <p className="muted small center-text">{t("signin.or")}</p>}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || disabled}
            onClick={() => void run(() => store.signInWithGoogle())}
            data-testid={`${testId}-google`}
          >
            {t("signin.google")}
          </button>
          <p className="muted small">{t("signin.googleHint")}</p>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Reasons with words of their own in this sentence (others use the error's text). */
const ABSORB_REASONS = ["bad_transfer", "rate_limited", "active_ride", "already_merged", "account_merged", "unavailable", "two_families"];

/**
 * This phone's old account was not joined to the signed-in one (FR-327): why — with Try again while
 * its code lives and the reason can pass — or that it was parked for another sign-in. Stays until closed.
 */
export function AbsorbIssueCard() {
  const { t } = useI18n();
  const app = useApp();
  const store = useStore();
  const [busy, run] = useBusy();
  const issue = app.absorbIssue;
  if (!issue) return null;
  const id = issue.publicId ?? "—";
  const reason = issue.reason ? t((ABSORB_REASONS.includes(issue.reason) ? `absorb.${issue.reason}` : `err.${issue.reason}`) as MessageKey) : "";
  const p = readAbsorb();
  const retry = issue.retry && !!p && p.exp > Date.now();
  const text = !issue.reason
    ? t("signin.absorbSkipped", { publicId: id })
    : retry
      ? t("signin.absorbFailed", { publicId: id, reason })
      : t("signin.absorbFinal", { publicId: id, reason });
  return (
    <div className="absorb-issue" data-testid="absorb-issue">
      <Notice kind="warn">
        <p>{text}</p>
        <div className="row wrap">
          {retry && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => store.retryAbsorb())}>
              {t("signin.retryAbsorb")}
            </button>
          )}
          <button type="button" className="btn btn-link" onClick={() => store.dismissAbsorbIssue()}>
            {t("common.close")}
          </button>
        </div>
      </Notice>
    </div>
  );
}
