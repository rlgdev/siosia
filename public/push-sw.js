/* global self, URL, MessageChannel, setTimeout, clearTimeout */
// Web Push for Siosia — imported into the generated service worker (vite.config.ts → importScripts).
// Shows what the push-dispatch Edge Function sent ({title, body, tag, url, kind, room}); tapping the
// notification focuses the open app or opens it.
//
// 2.3 chat (FR-222, V48): a message whose thread is open in a visible window of the app goes to that
// window instead of becoming a notification. The worker asks every visible window
// ({type: "siosia-chat-open?", room} with a MessageChannel port; the app answers {open: true} on the
// port when that room's thread is in front) and shows the notification unless one says yes within
// CHAT_ASK_MS. No answer (an older app, a window that does not listen), a hidden window, no window:
// the notification shows, as always. The window that said yes gets
// {type: "siosia-chat-message", room, title, body, url} so its thread can refresh at once.
//
// iOS always shows regardless: WebKit (iOS home-screen apps, Safari on Mac) treats a push that shows
// no notification as a silent push and revokes the subscription after three — so there the worker
// never asks. Chrome shows its own "updated in the background" notice for a silent push unless a
// window of the site is visible, which is exactly the one case the notification is skipped in.

const CHAT_ASK_MS = 300;
const ua = (self.navigator && self.navigator.userAgent) || "";
const ALWAYS_SHOW = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrom(e|ium)\/|Edg\/|Firefox\//.test(ua));

/** The room of a chat push: params.room from dispatch, or the tag "chat:<room>" (older payloads). */
function chatRoomOf(data) {
  const tag = typeof data.tag === "string" ? data.tag : "";
  if (data.kind !== "chat_message" && !tag.startsWith("chat:")) return null;
  return data.room || tag.slice(5) || null;
}

/** The visible app window with this room's thread in front, or null (nobody said yes in time). */
async function windowShowingChat(room) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const visible = windows.filter((w) => w.url.startsWith(self.registration.scope) && w.visibilityState === "visible");
  if (visible.length === 0) return null;
  return new Promise((resolve) => {
    const ports = [];
    let left = visible.length;
    let done = false;
    const finish = (w) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const p of ports) p.close();
      resolve(w);
    };
    const timer = setTimeout(() => finish(null), CHAT_ASK_MS);
    for (const w of visible) {
      const channel = new MessageChannel();
      ports.push(channel.port1);
      channel.port1.onmessage = (ev) => {
        if (ev.data && ev.data.open === true) finish(w);
        else if (--left === 0) finish(null);
      };
      w.postMessage({ type: "siosia-chat-open?", room }, [channel.port2]);
    }
  });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = (event.data ? event.data.json() : null) || {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const show = () =>
    self.registration.showNotification(data.title || "Siosia", {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: data.url || "./" }
    });
  const room = ALWAYS_SHOW ? null : chatRoomOf(data);
  event.waitUntil(
    room === null
      ? show()
      : windowShowingChat(room)
          .then((w) => {
            if (!w) return show();
            w.postMessage({ type: "siosia-chat-message", room, title: data.title || "", body: data.body || "", url: data.url || "./" });
          })
          .catch(() => show())
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows)
        if (w.url.startsWith(self.registration.scope) && "focus" in w) {
          // The app is open: bring it to the front and show the screen the notification is about.
          w.postMessage({ type: "siosia-open", url });
          return w.focus();
        }
      return self.clients.openWindow(url);
    })()
  );
});
