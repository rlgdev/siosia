// 2.12 (FR-326): a Google round trip. Google comes back with the session (or an error) in the
// address. Only a return THIS tab started is accepted: a link carrying someone else's session
// (login CSRF) is never saved, never takes this phone's old account in, and its tokens are wiped
// from the address; Google's own error text is never shown (only a fixed reason).

const RETURN_KEY = "siosia.authReturn";
const STARTED_KEY = "siosia.googleStarted";
const STARTED_MS = 10 * 60_000;
const SESSION_PARAMS = ["access_token", "refresh_token", "expires_in", "expires_at", "token_type", "provider_token", "provider_refresh_token", "type"];
const ERROR_PARAMS = ["error", "error_code", "error_description"];

export type GoogleIntent = "signin" | "link";
/** A fixed reason for a Google round trip that did not finish (never Google's text). */
export type GoogleError = "cancelled" | "in_use" | "failed";

/** Called right before leaving for Google. */
export function markGoogleStart(intent: GoogleIntent): void {
  try {
    sessionStorage.setItem(STARTED_KEY, JSON.stringify({ intent, at: Date.now() }));
  } catch {
    /* storage unavailable: the return is then not accepted */
  }
}

/** The round trip is over (it failed before leaving, or a page loaded without a Google return). */
export function clearGoogleStart(): void {
  try {
    sessionStorage.removeItem(STARTED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The Google round trip this tab started in the last 10 minutes, if any. */
export function googleStarted(): { intent: GoogleIntent } | null {
  try {
    const raw = sessionStorage.getItem(STARTED_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { intent?: GoogleIntent; at?: number };
    if (!s.at || Date.now() - s.at > STARTED_MS) return null;
    return { intent: s.intent === "link" ? "link" : "signin" };
  } catch {
    return null;
  }
}

/** supabase-js `detectSessionInUrl`: a session in the address is taken only from a return this tab started. */
export function acceptUrlSession(_url: URL, params: Record<string, string>): boolean {
  return !!googleStarted() && Boolean(params.access_token || params.error || params.error_code || params.error_description);
}

function stripParams(names: string[]): void {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const search = new URLSearchParams(location.search);
  let changed = false;
  for (const n of names) {
    for (const p of [hash, search]) {
      if (!p.has(n)) continue;
      p.delete(n);
      changed = true;
    }
  }
  if (!changed) return;
  const s = search.toString();
  const h = hash.toString();
  history.replaceState(history.state, "", location.pathname + (s ? `?${s}` : "") + (h ? `#${h}` : ""));
}

/**
 * Keeps what a Google return left in the address before supabase-js reads it (main.tsx, first
 * thing). Google's error is taken out of the address at once (a reload must not show it again); a
 * session this tab did not ask for is wiped.
 */
export function captureAuthReturn(): void {
  try {
    const where = `${location.hash.replace(/^#/, "")}&${location.search.replace(/^\?/, "")}`;
    if (!/(^|&)(access_token|error_code|error)=/.test(where)) {
      clearGoogleStart(); // a page without a Google return: no round trip is pending any more
      return;
    }
    // Only what takeAuthReturn needs — never the tokens themselves.
    const q = new URLSearchParams(where);
    const keep = new URLSearchParams();
    for (const k of ["error", "error_code"]) {
      const v = q.get(k);
      if (v) keep.set(k, v);
    }
    if (q.has("access_token")) keep.set("access_token", "1");
    sessionStorage.setItem(RETURN_KEY, keep.toString());
    stripParams(googleStarted() ? ERROR_PARAMS : [...ERROR_PARAMS, ...SESSION_PARAMS]);
  } catch {
    /* storage unavailable: a Google sign-in still works, only its error is not explained */
  }
}

// Back from Google's page by the browser's Back (a page restored from memory): no return is coming.
if (typeof window !== "undefined")
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) clearGoogleStart();
  });

/** What came back from Google in this page load, for a round trip this tab started. Read once. */
export function takeAuthReturn(): { google: boolean; intent: GoogleIntent | null; error: GoogleError | null } {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    const started = googleStarted();
    sessionStorage.removeItem(RETURN_KEY);
    if (!raw) return { google: false, intent: null, error: null };
    sessionStorage.removeItem(STARTED_KEY);
    if (!started) return { google: false, intent: null, error: null };
    const p = new URLSearchParams(raw);
    const code = p.get("error_code") || p.get("error");
    if (code) {
      const error: GoogleError = /access_denied|cancel/i.test(code) ? "cancelled" : /already_exists|exists/i.test(code) ? "in_use" : "failed";
      return { google: false, intent: started.intent, error };
    }
    return { google: started.intent === "signin" && p.has("access_token"), intent: started.intent, error: null };
  } catch {
    return { google: false, intent: null, error: null };
  }
}
