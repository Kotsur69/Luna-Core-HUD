// LunaCore - Supabase Edge Function `google` (Deno entry). The logic lives in
// core.mjs; this file only binds it to Deno's env and server. Deployed with
// verify_jwt = false: core.mjs checks the session against the Auth server
// itself (the gateway check doesn't understand the new key types).
import { handle, googleFromEnv, createLimiter } from './core.mjs';

let google;
// Kept for the isolate's life, like the access token: reads 60/min, new events 10/hour.
const limits = { events: createLimiter(60, 60000), mail: createLimiter(60, 60000), create: createLimiter(10, 3600000) };
const env = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? Deno.env.get(key) : undefined) });

Deno.serve((req) =>
  handle(req, {
    env,
    // Created on first use and kept, so a warm isolate reuses its access token.
    google: () => (google ??= googleFromEnv(env)),
    limits,
    log: (msg) => console.error(msg),
  }),
);
