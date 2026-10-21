// LunaCore - Supabase Edge Function `push` (Deno entry). The logic lives in
// core.mjs; this file only binds it to Deno's env, server and web-push.
// Deployed with verify_jwt = false: core.mjs checks the owner's session
// itself, and the schedule calls it with x-cron-secret instead of a session.
//
// Schedule (Supabase dashboard -> Cron, every 2 min): POST this function with
// body {"event":"offline-check"} and header x-cron-secret = the CRON_SECRET secret.
import webpush from 'npm:web-push@3.6.7';
import { handle, createDb } from './core.mjs';

const env = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? Deno.env.get(key) : undefined) });

let vapidReady = false;
function sendPush(subscription, payload) {
  if (!vapidReady) {
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:lunacore@example.invalid', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
  return webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: 'high' });
}

const configured = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

Deno.serve((req) =>
  handle(req, {
    env,
    db: () => (configured() ? createDb({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }) : null),
    sendPush: configured() ? sendPush : null,
    log: (msg) => console.error(msg),
  }),
);
