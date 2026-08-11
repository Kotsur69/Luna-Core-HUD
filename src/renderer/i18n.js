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
    'claude.missing.title': 'Nie znaleziono Claude Code',
    'claude.missing.body':
      'Terminal dziala, ale komenda "claude" nie jest na PATH. Zainstaluj Claude Code, aby korzystac z pelnego HUD-a.',
    'claude.missing.install': 'Jak zainstalowac',
    'claude.missing.dismiss': 'Zamknij',
    'appearance.title': 'Wyglad',
    'appearance.theme': 'Motyw',
    'appearance.layout': 'Uklad',
    'appearance.lang': 'Jezyk',
    'appearance.sound': 'Dzwiek',
    'appearance.sound.hint': 'Dzwiekowe sprzezenie zwrotne (klawisze, zakladki, przelaczniki). Wymaga mpv na PATH - w przeciwnym razie cicho nic nie robi.',
    'appearance.keystrokeSound': 'Dzwiek klawiszy',
    'appearance.volume': 'Glosnosc',
    'update.checking': 'sprawdzanie aktualizacji...',
    'update.current': 'wersja {v} - aktualna',
    'update.available': 'dostepna wersja {v}',
    'update.download': 'Pobierz',
    'update.downloading': 'pobieranie... {p}%',
    'update.ready': 'wersja {v} gotowa do instalacji',
    'update.install': 'Zainstaluj i uruchom ponownie',
    'update.error': 'nie udalo sie sprawdzic aktualizacji',
    'update.retry': 'Ponow',
    'update.check': 'Sprawdz',
    'update.notes': 'Informacje o wydaniu',
    'update.portable': 'wersja {v} (portable) - aktualizuj recznie',
    'boot.label': 'Sekwencja startowa',
    'boot.hint': 'Krotka animacja startowa przy uruchomieniu. Czysta ozdoba - nie opoznia sesji, PTY startuje pod spodem. Systemowe "ogranicz ruch" wylacza ja calkowicie.',
    'boot.on': 'wlaczona',
    'boot.off': 'wylaczona',
    'boot.skip': 'klik lub dowolny klawisz = pomin',

    // Zakladki sesji
    'tabs.new': 'Nowa sesja',
    'tabs.close': 'Zamknij sesje',
    'boot.line.pty': 'mostek PTY',
    'boot.line.observer': 'pasywny obserwator',
    'boot.line.injector': 'wstrzykiwacz akcji',
    'boot.line.theme': 'silnik motywow',
    'boot.line.skills': 'indeks skilli',
    'boot.line.ok': 'OK',
    'boot.line.ready': 'LUNACORE GOTOWY',
    'project.title': 'Projekt',
    'project.hint': 'Zmiana katalogu restartuje sesje w nowym folderze.',
    'profile.title': 'Profil',
    'profile.hint': 'Zmiana profilu restartuje sesje z nowym srodowiskiem.',
    'cheats.title': 'Sciagi / Komendy',
    'prompts.title': 'Prompty',
    'prompts.send.title': 'Wklej i wyslij od razu',
    'skills.title': 'Skille',
    // Nazwy kategorii skilli. Klucz to slug z src/skills.js (CATEGORIES.id),
    // a nie tekst - dzieki temu naglowki przelaczaja jezyk razem z reszta HUD.
    'skills.cat.frontend': 'Frontend',
    'skills.cat.backend': 'Backend',
    'skills.cat.data-ml': 'Dane / ML',
    'skills.cat.devops': 'DevOps / Deploy',
    'skills.cat.tests': 'Testy',
    'skills.cat.security': 'Bezpieczenstwo',
    'skills.cat.database': 'Baza danych',
    'skills.cat.git-review': 'Git / Review',
    'skills.cat.docs': 'Dokumentacja',
    'skills.cat.other': 'Inne',
    'skills.search.ph': 'Filtruj skille...',
    'skills.search.empty': 'Brak skilli dla tego filtra.',
    'skills.rescan.title': 'Odswiez liste skilli',
    'palette.chip.title': 'Paleta komend (Ctrl+K)',
    'ctx.waiting': 'Oczekiwanie na transcript sesji...',
    'ctx.copyPath.title': 'Kopiuj sciezke transcriptu tej sesji (.jsonl)',
    'burn.collecting': 'Zbieranie probek...',
    'ctxwin.title': 'Okno kontekstu',
    'skilltracker.title': 'Tracker narzedzi',
    'skilltracker.hint': 'Kafelek swieci, gdy Claude uzywa narzedzia.',
    'ports.title': 'Porty localhost',
    'ports.scanning': 'Skanowanie portow...',
    'ports.empty': 'Brak nasluchujacych portow.',
    'ports.filter.title': 'Ukryj / pokaz procesy systemowe (svchost, RPC, porty < 1024)',
    'ports.hidden': '{n} systemowych ukrytych',
    'ports.allHidden': 'Same procesy systemowe ({n}) - kliknij ◉, by je pokazac.',
    'telemetry.title': 'System',
    'telemetry.ram': 'RAM',
    'telemetry.cpu': 'CPU',
    'telemetry.cores': '{n} rdzeni',
    'telemetry.uptime': 'Czas pracy',
    'telemetry.load': 'Obciazenie',
    'telemetry.pause': 'Zatrzymaj wykres (probki lecą dalej)',
    'telemetry.resume': 'Wznow wykres',
    'telemetry.waiting': 'Czekam na pierwszy odczyt...',
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
    'claude.missing.title': 'Claude Code not found',
    'claude.missing.body':
      'The terminal works, but the "claude" command is not on your PATH. Install Claude Code to use the full HUD.',
    'claude.missing.install': 'How to install',
    'claude.missing.dismiss': 'Dismiss',
    'appearance.title': 'Appearance',
    'appearance.theme': 'Theme',
    'appearance.layout': 'Layout',
    'appearance.lang': 'Language',
    'appearance.sound': 'Sound',
    'appearance.sound.hint': 'Sound feedback (keystrokes, tabs, toggles). Needs mpv on PATH - silently does nothing otherwise.',
    'appearance.keystrokeSound': 'Keystroke sound',
    'appearance.volume': 'Volume',
    'update.checking': 'checking for updates...',
    'update.current': 'version {v} - up to date',
    'update.available': 'version {v} available',
    'update.download': 'Download',
    'update.downloading': 'downloading... {p}%',
    'update.ready': 'version {v} ready to install',
    'update.install': 'Install and restart',
    'update.error': 'could not check for updates',
    'update.retry': 'Retry',
    'update.check': 'Check',
    'update.notes': 'Release notes',
    'update.portable': 'version {v} (portable) - update manually',
    'boot.label': 'Boot sequence',
    'boot.hint': 'Short startup animation. Pure decoration - it does not delay the session, the PTY starts underneath. The system "reduce motion" setting disables it entirely.',
    'boot.on': 'on',
    'boot.off': 'off',
    'boot.skip': 'click or any key to skip',

    // Session tabs
    'tabs.new': 'New session',
    'tabs.close': 'Close session',
    'boot.line.pty': 'PTY bridge',
    'boot.line.observer': 'passive observer',
    'boot.line.injector': 'action injector',
    'boot.line.theme': 'theme engine',
    'boot.line.skills': 'skill index',
    'boot.line.ok': 'OK',
    'boot.line.ready': 'LUNACORE READY',
    'project.title': 'Project',
    'project.hint': 'Switching the directory restarts the session in the new folder.',
    'profile.title': 'Profile',
    'profile.hint': 'Switching the profile restarts the session with a new environment.',
    'cheats.title': 'Cheatsheets / Commands',
    'prompts.title': 'Prompts',
    'prompts.send.title': 'Paste and send immediately',
    'skills.title': 'Skills',
    // Skill category labels. The key is the slug from src/skills.js
    // (CATEGORIES.id), never display text - see the PL block above.
    'skills.cat.frontend': 'Frontend',
    'skills.cat.backend': 'Backend',
    'skills.cat.data-ml': 'Data / ML',
    'skills.cat.devops': 'DevOps / Deploy',
    'skills.cat.tests': 'Tests',
    'skills.cat.security': 'Security',
    'skills.cat.database': 'Database',
    'skills.cat.git-review': 'Git / Review',
    'skills.cat.docs': 'Docs',
    'skills.cat.other': 'Other',
    'skills.search.ph': 'Filter skills...',
    'skills.search.empty': 'No skills match that filter.',
    'skills.rescan.title': 'Rescan skills',
    'palette.chip.title': 'Command palette (Ctrl+K)',
    'ctx.waiting': 'Waiting for session transcript...',
    'ctx.copyPath.title': 'Copy this session transcript path (.jsonl)',
    'burn.collecting': 'Collecting samples...',
    'ctxwin.title': 'Context Window',
    'skilltracker.title': 'Skill Tracker',
    'skilltracker.hint': 'A tile lights up when Claude uses a tool.',
    'ports.title': 'Localhost ports',
    'ports.scanning': 'Scanning ports...',
    'ports.empty': 'No listening ports.',
    'ports.filter.title': 'Hide / show system processes (svchost, RPC, ports < 1024)',
    'ports.hidden': '{n} system processes hidden',
    'ports.allHidden': 'Only system processes here ({n}) - click ◉ to show them.',
    'telemetry.title': 'System',
    'telemetry.ram': 'RAM',
    'telemetry.cpu': 'CPU',
    'telemetry.cores': '{n} cores',
    'telemetry.uptime': 'Uptime',
    'telemetry.load': 'Load',
    'telemetry.pause': 'Freeze the chart (sampling continues)',
    'telemetry.resume': 'Resume the chart',
    'telemetry.waiting': 'Waiting for the first reading...',
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
