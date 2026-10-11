// Notifications. Real ones are Web Push: on iPhone only in the Home Screen app (iOS 16.4+), turned
// on with a tap. The server queues events (push_outbox) and the Edge Function push-dispatch sends
// them; the service worker (public/push-sw.js) shows them. The in-browser demo backend has no push
// service, so its events are shown by the page itself.

import type { Backend } from "../backend/types";
import { isIOS, isStandalone, readPref, writePref } from "./device";

export type PushState = "unsupported" | "needs-app" | "not-configured" | "off" | "on" | "blocked";

const hasNotification = () => typeof window !== "undefined" && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker?.getRegistration();
  } catch {
    return undefined;
  }
}

export async function pushState(api: Backend, vapidKey: string): Promise<PushState> {
  if (isIOS() && !isStandalone()) return "needs-app";
  if (!hasNotification() || !("serviceWorker" in navigator)) return "unsupported";
  if (api.kind === "supabase") {
    if (!("PushManager" in window)) return "unsupported";
    if (!vapidKey) return "not-configured";
  }
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  if (api.kind === "mock") return readPref<boolean>("push.off", false) ? "off" : "on";
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return "off";
  // The server may have dropped it (profile moved or deleted, 410 from the push service): re-save.
  const json = sub.toJSON();
  await api.savePush({ endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" }).catch(() => {});
  return "on";
}

/** Must run from a tap (iOS asks only then). */
export async function enablePush(api: Backend, vapidKey: string): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm === "denied") return "blocked";
  if (perm !== "granted") return "off";
  writePref("push.off", null);
  if (api.kind === "mock") return "on";
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker not ready")), 10_000))
  ]);
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidKey) as BufferSource }));
  const json = sub.toJSON();
  await api.savePush({ endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" });
  return "on";
}

export async function disablePush(api: Backend): Promise<PushState> {
  writePref("push.off", true);
  if (api.kind === "mock") return "off";
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) {
    await api.deletePush(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => false);
  }
  return "off";
}

/** Shows a notification from the page (demo backend, app in the background). */
export async function showLocal(title: string, body: string, tag: string): Promise<boolean> {
  if (!hasNotification() || Notification.permission !== "granted" || readPref<boolean>("push.off", false)) return false;
  const reg = await registration();
  const opts = { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./" } };
  try {
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
    return true;
  } catch {
    return false;
  }
}

function base64UrlToBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
