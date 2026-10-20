// Supabase Edge Function "calendar" (Deno): serves the per-viewer .ics links the app shows under
// Add to calendar (FR-135, FR-136). The link carries its own token, so the phone's calendar opens it
// without signing in: deploy with JWT verification off, then put the function's URL in
// app_config.calendar_function_url (docs/SETUP.md):
//   supabase functions deploy calendar --no-verify-jwt   — or the dashboard editor (dist-bundle.ts)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY come from Supabase.

// Deno runtime (npm: specifiers, Deno globals): outside the app's TypeScript project; Supabase checks it at deploy.
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
import { handleCalendar, type CalendarView } from "./handler.ts";

Deno.serve((req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  return handleCalendar(req, async (kind, id, publicId, token) => {
    const { data, error } = await db.rpc("siosia_calendar_view", { p_kind: kind, p_id: id, p_public: publicId, p_token: token });
    if (error) throw error;
    return (data ?? null) as CalendarView | null;
  });
});
