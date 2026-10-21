import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/** Acts as the signed-in user (their cookie session): row-level security applies. */
export async function supabaseForUser() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* a route handler that only reads may not set cookies; the middleware refreshes them */
        }
      },
    },
  });
}

/** The signed-in user's id, or null. getUser() re-checks the token with Supabase Auth. */
export async function currentUserId(): Promise<string | null> {
  const supabase = await supabaseForUser();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** Server-only service-role client, for the confirm-card store. Never import this from a client file. */
export function supabaseService() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
