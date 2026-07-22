// ============================================================================
// LunaCore - i18n (PL / EN)
// ----------------------------------------------------------------------------
// Lekki slownik tlumaczen dla warstwy UI. Statyczne etykiety w index.html nosza
// atrybut data-i18n / data-i18n-ph / data-i18n-title; applyStatic() je uzupelnia.
// Napisy dynamiczne w renderer.js ida przez t('klucz', { param }).
//
// Bez zaleznosci, bez IPC - czysto rendererowe. Brakujacy klucz => fallback do
// PL, a jak i tego brak => sam klucz (widoczne, ze cos nie przetlumaczone).
// ============================================================================

'use strict';

// IIFE: nie wyciekamy zadnych nazw (t, I18N_DICT, setLang...) do globalnego
// scope. renderer.js ma wlasne `const t`, wiec kolizja `t` w globalnym scope
// zabijala CALY renderer (SyntaxError: Identifier 't' has already been
// declared). Jedyny publiczny eksport to window.i18n na koncu.
(function () {

const I18N_DICT = {
  pl: {
    'actions.title': 'Akcje',
    'compact.title': 'Wyslij /compact do Claude CLI',
    'autocompact.label': 'Auto-compact',
    'autocompact.hint': 'Gdy kontekst przekroczy prog 85%, LunaCore sam wysle /compact. Domyslnie wylaczone - uzbrajasz swiadomie.',
    'autocompact.off': 'wylaczone',
    'autocompact.armed': 'uzbrojone · prog 85%',
    'autocompact.fired': 'wyslano /compact',
    'appearance.title': 'Wyglad',
    'appearance.theme': 'Motyw',
    'appearance.lang': 'Jezyk',
    'project.title': 'Projekt',
    'project.hint': 'Zmiana katalogu restartuje sesje w nowym folderze.',
    'profile.title': 'Profil',
    'profile.hint': 'Zmiana profilu restartuje sesje z nowym srodowiskiem.',
    'cheats.title': 'Sciagi / Komendy',
    'prompts.title': 'Prompty',
    'skills.title': 'Skille',
    'palette.chip.title': 'Paleta komend (Ctrl+K)',
    'ctx.waiting': 'Oczekiwanie na transcript sesji...',
    'burn.collecting': 'Zbieranie probek...',
    'ctxwin.title': 'Okno kontekstu',
    'skilltracker.title': 'Tracker narzedzi',
    'skilltracker.hint': 'Kafelek swieci, gdy Claude uzywa narzedzia.',
    'ports.title': 'Porty localhost',
    'ports.scanning': 'Skanowanie portow...',
    'ports.empty': 'Brak nasluchujacych portow.',
    'pad.title': 'Brudnopis',
    'pad.placeholder': 'Notatki, sniplety, TODO na pozniej...',
    'pad.send': 'Wklej do sesji',
    'pad.send.title': 'Wklej tresc brudnopisu do sesji',
    'palette.input.ph': 'Szukaj akcji, komend, promptow, skilli...',
    'palette.foot.nav': 'nawigacja',
    'palette.foot.use': 'uzyj',
    'palette.foot.send': 'wyslij prompt',
    'palette.foot.close': 'zamknij',
    'ptystatus.connecting': 'PTY: laczenie...',
    'ptystatus.active': 'PTY: aktywne',
    'ptystatus.ended': 'PTY: zakonczono (kod {code})',
    'led.working': 'pracuje...',
    'led.waiting': 'czeka na Ciebie',
    'led.dead': 'sesja zakonczona',
    'log.session.ended': '[LunaCore] Sesja PTY zakonczona (kod {code}).',
    'log.session.switched': '[LunaCore] Sesja przelaczona na profil: {label}',
    'log.session.project': '[LunaCore] Sesja: {label} @ {folder}',
    'ctx.warn.compact': 'Compact this shit!',
    'ctx.tokens': '{used} / {limit} tokenow',
    'burn.up': '▲ {rate} tok/min{eta}',
    'burn.down': '▼ {rate} tok/min (spada)',
    'burn.stable': 'stabilny',
    'burn.eta.to85': ' · ~{min} min do 85%',
    'burn.eta.zone': ' · w strefie compact',
    'usage.title': 'Limity uzycia',
    'usage.refresh.title': 'Odswiez zuzycie',
    'usage.loading': 'Sprawdzanie limitow...',
    'usage.window.5h': '5 godzin',
    'usage.window.week': 'Tydzien',
    'usage.window.opus': 'Tydzien · Opus',
    'usage.window.sonnet': 'Tydzien · Sonnet',
    'usage.resetIn': 'reset za {when}',
    'usage.resetting': 'trwa reset...',
    'usage.extra': '+ dodatkowe zuzycie wlaczone',
    'usage.reauth': 'Token wygasl - uruchom `claude`, by go odswiezyc.',
    'usage.unavailable': 'Dane niedostepne (endpoint / siec).',
    'usage.off': 'Licznik wylaczony (ENABLE_USAGE_METER).',
    'ports.open.title': 'Otworz w przegladarce',
    'ports.copy.title': 'Kopiuj URL',
    'ports.kill.title': 'Zabij proces',
    'ports.kill.confirm': 'Zabic proces {name} (PID {pid}) na porcie {port}?',
    'pad.saved': 'zapisano',
    'pad.saveError': 'blad zapisu',
    'palette.kind.action': 'AKCJA',
    'palette.kind.command': 'KMD',
    'palette.kind.prompt': 'PROMPT',
    'palette.kind.skill': 'SKILL',
    'palette.empty': 'Brak dopasowan.',
    'palette.action.sub': 'Akcja',
    'palette.hint.promptPaste': 'wklej · ⇧ wyslij',
    'palette.hint.skillCopy': 'kopiuj nazwe',
  },
  en: {
    'actions.title': 'Actions',
    'compact.title': 'Send /compact to the Claude CLI',
    'autocompact.label': 'Auto-compact',
    'autocompact.hint': 'When context crosses the 85% threshold, LunaCore sends /compact for you. Off by default - you arm it deliberately.',
    'autocompact.off': 'off',
    'autocompact.armed': 'armed · 85% threshold',
    'autocompact.fired': '/compact sent',
    'appearance.title': 'Appearance',
    'appearance.theme': 'Theme',
    'appearance.lang': 'Language',
    'project.title': 'Project',
    'project.hint': 'Switching the directory restarts the session in the new folder.',
    'profile.title': 'Profile',
    'profile.hint': 'Switching the profile restarts the session with a new environment.',
    'cheats.title': 'Cheatsheets / Commands',
    'prompts.title': 'Prompts',
    'skills.title': 'Skills',
    'palette.chip.title': 'Command palette (Ctrl+K)',
    'ctx.waiting': 'Waiting for session transcript...',
    'burn.collecting': 'Collecting samples...',
    'ctxwin.title': 'Context Window',
    'skilltracker.title': 'Skill Tracker',
    'skilltracker.hint': 'A tile lights up when Claude uses a tool.',
    'ports.title': 'Localhost ports',
    'ports.scanning': 'Scanning ports...',
    'ports.empty': 'No listening ports.',
    'pad.title': 'Scratchpad',
    'pad.placeholder': 'Notes, snippets, TODOs for later...',
    'pad.send': 'Paste into session',
    'pad.send.title': 'Paste scratchpad contents into the session',
    'palette.input.ph': 'Search actions, commands, prompts, skills...',
    'palette.foot.nav': 'navigate',
    'palette.foot.use': 'use',
    'palette.foot.send': 'send prompt',
    'palette.foot.close': 'close',
    'ptystatus.connecting': 'PTY: connecting...',
    'ptystatus.active': 'PTY: active',
    'ptystatus.ended': 'PTY: ended (code {code})',
    'led.working': 'working...',
    'led.waiting': 'waiting for you',
    'led.dead': 'session ended',
    'log.session.ended': '[LunaCore] PTY session ended (code {code}).',
    'log.session.switched': '[LunaCore] Session switched to profile: {label}',
    'log.session.project': '[LunaCore] Session: {label} @ {folder}',
    'ctx.warn.compact': 'Compact this shit!',
    'ctx.tokens': '{used} / {limit} tokens',
    'burn.up': '▲ {rate} tok/min{eta}',
    'burn.down': '▼ {rate} tok/min (falling)',
    'burn.stable': 'stable',
    'burn.eta.to85': ' · ~{min} min to 85%',
    'burn.eta.zone': ' · in compact zone',
    'usage.title': 'Usage limits',
    'usage.refresh.title': 'Refresh usage',
    'usage.loading': 'Checking limits...',
    'usage.window.5h': '5-hour',
    'usage.window.week': 'Weekly',
    'usage.window.opus': 'Weekly · Opus',
    'usage.window.sonnet': 'Weekly · Sonnet',
    'usage.resetIn': 'resets in {when}',
    'usage.resetting': 'resetting...',
    'usage.extra': '+ extra usage enabled',
    'usage.reauth': 'Token expired - run `claude` to refresh it.',
    'usage.unavailable': 'Data unavailable (endpoint / network).',
    'usage.off': 'Meter disabled (ENABLE_USAGE_METER).',
    'ports.open.title': 'Open in browser',
    'ports.copy.title': 'Copy URL',
    'ports.kill.title': 'Kill process',
    'ports.kill.confirm': 'Kill process {name} (PID {pid}) on port {port}?',
    'pad.saved': 'saved',
    'pad.saveError': 'save error',
    'palette.kind.action': 'ACTION',
    'palette.kind.command': 'CMD',
    'palette.kind.prompt': 'PROMPT',
    'palette.kind.skill': 'SKILL',
    'palette.empty': 'No matches.',
    'palette.action.sub': 'Action',
    'palette.hint.promptPaste': 'paste · ⇧ send',
    'palette.hint.skillCopy': 'copy name',
  },
};

let currentLang = 'pl';

/** Podmienia {placeholdery} wartosciami z params. */
function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m));
}

/** Tlumaczy klucz na aktualny jezyk (fallback: PL -> sam klucz). */
function t(key, params) {
  const dict = I18N_DICT[currentLang] || I18N_DICT.pl;
  const str = (key in dict ? dict[key] : I18N_DICT.pl[key]) ?? key;
  return interpolate(str, params);
}

/** Ustawia aktualny jezyk (nieznany => 'pl'). */
function setLang(lang) {
  currentLang = I18N_DICT[lang] ? lang : 'pl';
}

/** Uzupelnia statyczne etykiety w DOM (textContent / placeholder / title). */
function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPh));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  document.documentElement.lang = currentLang;
}

window.i18n = {
  t,
  setLang,
  applyStatic,
  get lang() {
    return currentLang;
  },
};

})();
