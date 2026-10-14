-- rls_auto_enable() is Supabase's event-trigger helper (trigger ensure_rls) that
-- turns RLS on for every new table. It is not meant to be reachable over RPC.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
