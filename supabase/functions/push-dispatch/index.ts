// Supabase Edge Function "push-dispatch" (Deno). The database calls it (pg_net) right after it
// queues notifications and every minute while some are left; it sends them with Web Push.
// Nothing to configure by hand: it checks the caller against app_secrets.push_secret (made by the
// migration) and creates its VAPID key pair on first run, kept in app_secrets — the app reads the
// public key from siosia_config(). (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY come from Supabase.)
// Optional overrides: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// Deploy with JWT verification off (the database calls it with its own secret header):
//   supabase functions deploy push-dispatch --no-verify-jwt   — or the dashboard editor (dist-bundle.ts)

// Deno runtime (npm: specifiers, Deno globals): outside the app's TypeScript project; Supabase checks it at deploy.
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import webpush from "npm:web-push@3.6.7";
import { dispatch } from "./dispatch.ts";

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data: secrets, error: secretsError } = await db.from("app_secrets").select("push_secret, vapid_public, vapid_private").eq("id", 1).single();
  if (secretsError || !secrets?.push_secret || req.headers.get("x-push-secret") !== secrets.push_secret) {
    return new Response("forbidden", { status: 403 });
  }
  let pub = Deno.env.get("VAPID_PUBLIC_KEY") || secrets.vapid_public;
  let priv = Deno.env.get("VAPID_PRIVATE_KEY") || secrets.vapid_private;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    // Only the first run stores keys (a parallel first run keeps the winner's pair).
    await db.from("app_secrets").update({ vapid_public: keys.publicKey, vapid_private: keys.privateKey }).eq("id", 1).is("vapid_public", null);
    const { data: kept } = await db.from("app_secrets").select("vapid_public, vapid_private").eq("id", 1).single();
    pub = kept?.vapid_public ?? keys.publicKey;
    priv = kept?.vapid_private ?? keys.privateKey;
  }
  const { data: cfg } = await db.from("app_config").select("site_url, operator_contact").eq("id", 1).single();
  const contact = cfg?.operator_contact ?? "";
  const subject =
    Deno.env.get("VAPID_SUBJECT") ||
    (/^[^@\s]+@[^@\s]+$/.test(contact) ? `mailto:${contact}` : "") ||
    cfg?.site_url ||
    "https://github.com/rlgdev/siosia";
  webpush.setVapidDetails(subject, pub, priv);
  const result = await dispatch({
    async pending(limit) {
      // Atomic claim: overlapping runs never send the same row twice.
      const { data, error } = await db.rpc("siosia_claim_push", { p_limit: limit });
      if (error) throw error;
      return data ?? [];
    },
    async subscriptions(userId) {
      const { data, error } = await db.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", userId);
      if (error) throw error;
      return data ?? [];
    },
    async send(sub, payload) {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600, urgency: "high" });
    },
    async markSent(id) {
      await db.from("push_outbox").update({ sent_at: new Date().toISOString() }).eq("id", id);
    },
    async markFailed(id) {
      await db.from("push_outbox").update({ claimed_at: null }).eq("id", id);
    },
    async dropSubscription(endpoint) {
      await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
    },
    async isMessageRead(messageId) {
      // 2.3 (C6): the recipient read it meanwhile (the thread was in front) — no push for it then.
      // Service role (messages is RLS-locked to the room's parties). In doubt — an id the table does
      // not know, a hiccup — the message is sent.
      const { data, error } = await db.from("messages").select("read_at").eq("id", messageId).maybeSingle();
      return !error && !!data?.read_at;
    }
  });
  return Response.json({ ...result, vapidPublicKey: pub });
});
