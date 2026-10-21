// ============================================================================
// LunaCore - host first-run setup: state, tray strings, pairing dialog (main)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, "Host runtime". A new host needs two things before
// it does anything for the phone:
//
//   login   the GitHub PKCE browser login of the HUD (src/cloudauth.js, the
//           session in safeStorage)
//   pair    a phone's passkey in host-keys.local.json (src/hostpairing.js)
//
// Until both are done the tray says "Needs setup" and src/hostmain.js neither
// heartbeats nor claims commands. Strings follow the system language (pl/en).
// ============================================================================

'use strict';

/** 'no-cloud' | 'login' | 'pair' | 'ready'. */
function decideSetup({ configured, loggedIn, paired }) {
  if (!configured) return 'no-cloud';
  if (!loggedIn) return 'login';
  if (!paired) return 'pair';
  return 'ready';
}

const STRINGS = {
  pl: {
    needsSetup: 'Wymaga konfiguracji',
    stateNoCloud: 'Brak konfiguracji chmury (config/cloud.local.json)',
    stateLogin: 'Zaloguj sie do chmury (GitHub)',
    statePair: 'Sparuj telefon',
    stateReady: 'Chmura: zalogowano · telefon sparowany',
    login: 'Zaloguj przez GitHub',
    pair: 'Sparuj telefon',
    pairOpen: 'Parowanie otwarte (10 min)',
    forget: 'Zapomnij wszystkie telefony',
    openLog: 'Otworz log',
    stop: 'Zatrzymaj',
    pairTitle: 'LunaCore: parowanie telefonu',
    pairMessage: 'Kod: {code}',
    pairDetail: '{label} chce sterowac tym komputerem ({machine}). Potwierdz tylko, jesli telefon pokazuje ten sam kod.',
    pairConfirm: 'Potwierdz',
    pairReject: 'Odrzuc',
    pairHintTitle: 'LunaCore: sparuj telefon',
    pairHint: 'Na telefonie otworz menu -> Sparuj komputer i wpisz nazwe tego komputera: {machine}. Okno parowania jest otwarte przez 10 minut.',
    forgetTitle: 'LunaCore: zapomnij telefony',
    forgetMessage: 'Usunac wszystkie sparowane telefony i ich sesje? Telefon trzeba bedzie sparowac od nowa.',
    forgetConfirm: 'Usun',
    cancel: 'Anuluj',
  },
  en: {
    needsSetup: 'Needs setup',
    stateNoCloud: 'No cloud config (config/cloud.local.json)',
    stateLogin: 'Log in to the cloud (GitHub)',
    statePair: 'Pair a phone',
    stateReady: 'Cloud: logged in · phone paired',
    login: 'Log in with GitHub',
    pair: 'Pair a phone',
    pairOpen: 'Pairing open (10 min)',
    forget: 'Forget all phones',
    openLog: 'Open log',
    stop: 'Stop',
    pairTitle: 'LunaCore: pair a phone',
    pairMessage: 'Code: {code}',
    pairDetail: '{label} wants to control this computer ({machine}). Confirm only if the phone shows the same code.',
    pairConfirm: 'Confirm',
    pairReject: 'Reject',
    pairHintTitle: 'LunaCore: pair a phone',
    pairHint: 'On the phone open menu -> Pair a host and enter this computer\'s name: {machine}. Pairing stays open for 10 minutes.',
    forgetTitle: 'LunaCore: forget phones',
    forgetMessage: 'Remove every paired phone and its sessions? The phone has to be paired again.',
    forgetConfirm: 'Remove',
    cancel: 'Cancel',
  },
};

/** An Electron locale ("pl", "pl-PL", "en-US") -> 'pl' | 'en'. */
const langOf = (locale) => (typeof locale === 'string' && locale.toLowerCase().startsWith('pl') ? 'pl' : 'en');

/** The string `key` in `lang`, {name} placeholders filled. */
function hostText(lang, key, vars = {}) {
  const table = STRINGS[lang] || STRINGS.en;
  const text = Object.hasOwn(table, key) ? table[key] : STRINGS.en[key] || key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

const STATE_KEYS = { 'no-cloud': 'stateNoCloud', login: 'stateLogin', pair: 'statePair', ready: 'stateReady' };

/** The tray's status line for a setup state. */
const setupLine = (lang, state) => hostText(lang, STATE_KEYS[state] || 'needsSetup');

/** "123456" -> "123 456": easier to compare at a glance. */
const spacedCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * The confirm dialog on this machine's screen. Resolves true only on Confirm.
 * @param {{dialog: object, lang: string, machine: string, code: string, label: string}} opts
 */
async function confirmPairing({ dialog, lang, machine, code, label }) {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: hostText(lang, 'pairTitle'),
    message: hostText(lang, 'pairMessage', { code: spacedCode(code) }),
    detail: hostText(lang, 'pairDetail', { label, machine }),
    buttons: [hostText(lang, 'pairConfirm'), hostText(lang, 'pairReject')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

module.exports = { decideSetup, hostText, langOf, setupLine, spacedCode, confirmPairing, STRINGS };
