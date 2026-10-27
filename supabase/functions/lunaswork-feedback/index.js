// LunaCore - Supabase Edge Function `lunaswork-feedback` (Deno entry). The
// logic lives in core.mjs; this file only binds it to Deno's env and server.
// Deployed with verify_jwt = false: the caller is a client on a staging build
// with no session; core.mjs checks the run's widget token itself.
import { handle, createDb } from './core.mjs';

const env = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? Deno.env.get(key) : undefined) });

const configured = () => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

Deno.serve((req) =>
  handle(req, {
    env,
    db: () => (configured() ? createDb({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }) : null),
    log: (msg) => console.error(msg),
  }),
);
