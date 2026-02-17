import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseAdminClient: SupabaseClient | null = null;

export function getSupabaseAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl === undefined || supabaseUrl.length === 0) {
    throw new Error("SUPABASE_URL is not configured.");
  }

  if (serviceRoleKey === undefined || serviceRoleKey.length === 0) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  if (supabaseAdminClient === null) {
    supabaseAdminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return supabaseAdminClient;
}
