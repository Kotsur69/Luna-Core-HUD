// ============================================================================
// LunaCore phone - Web Push subscription (REMOTE_HOST_PLAN H4)
// ----------------------------------------------------------------------------
// iOS 16.4+ delivers Web Push only to the installed PWA (Add to Home Screen).
// After Mati allows notifications (a tap: iOS asks only from a user gesture),
// the service worker's PushManager subscribes with the VAPID public key from
// the build (VITE_VAPID_PUBLIC_KEY) and the subscription goes to
// push_subscriptions. The `push` edge function sends; public/push-sw.js shows.
// ============================================================================

const KEY_RE = /^[A-Za-z0-9_-]{80,100}$/;

/** VAPID public key (base64url) -> the bytes PushManager wants. */
function keyBytes(b64u) {
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64u(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 'unsupported' | 'unconfigured' | 'denied' | 'default' | 'granted' */
export function pushState(env = import.meta.env) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (!KEY_RE.test(env.VITE_VAPID_PUBLIC_KEY || '')) return 'unconfigured';
  return Notification.permission;
}

/**
 * Asks for permission (call from a tap), subscribes and stores the
 * subscription. Resolves 'granted' or the state that stopped it.
 */
export async function enablePush(cloud, env = import.meta.env) {
  const state = pushState(env);
  if (state === 'unsupported' || state === 'unconfigured' || state === 'denied') return state;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(env.VITE_VAPID_PUBLIC_KEY) }));
  await cloud.savePush({ endpoint: sub.endpoint, p256dh: b64u(sub.getKey('p256dh')), auth: b64u(sub.getKey('auth')) });
  return 'granted';
}
