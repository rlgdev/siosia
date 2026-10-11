// Supabase Edge Function "push-dispatch" (Deno). Called every minute by pg_cron (see
// docs/SETUP.md → Notifications) and/or by a Database Webhook on push_outbox inserts. It sends
// the queued notifications with Web Push (VAPID). Secrets — never in the repository:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com), PUSH_SECRET
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.)
// Deploy: supabase functions deploy push-dispatch --no-verify-jwt   (the PUSH_SECRET header guards it)

// Deno runtime (npm: specifiers, Deno globals): outside the app's TypeScript project; Supabase checks it at deploy.
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import webpush from "npm:web-push@3.6.7";
import { dispatch } from "./dispatch.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("PUSH_SECRET");
  if (!secret || req.headers.get("x-push-secret") !== secret) return new Response("forbidden", { status: 403 });
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT"), Deno.env.get("VAPID_PUBLIC_KEY"), Deno.env.get("VAPID_PRIVATE_KEY"));
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const result = await dispatch({
    async pending(limit) {
      // Atomic claim: overlapping runs (cron + webhook) never send the same row twice.
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
    }
  });
  return Response.json(result);
});
