// ============================================================================
// LunaCore - renderer (frontend)
// ----------------------------------------------------------------------------
// * Renderuje terminal xterm.js i spina go z PTY przez most window.lunacore.
// * Obsluguje fizyczny przycisk COMPACT CONTEXT (Action Injector).
// * Motyw (theming) + jezyk (i18n) przelaczane na zywo z lewego panelu.
//
// Dostep do procesu glownego wylacznie przez `window.lunacore` (patrz preload.js).
// Globale `Terminal` i `FitAddon` pochodza z bibliotek xterm zaladowanych w HTML.
// Global `window.i18n` pochodzi z i18n.js (laduje sie przed tym plikiem).
// ============================================================================

'use strict';

// Skrot do tlumaczen. i18n.js wystawia window.i18n zanim ten plik sie wykona.
const t = (key, params) => window.i18n.t(key, params);

// ---- Zakladki sesji: jeden xterm na sesje ------------------------------------
//
// Kazda zakladka ma WLASNY proces PTY, wlasny bufor xterm i wlasne metryki.
// Zeby nie przepisywac calego pliku, `term` nizej to fasada: kieruje kazde
// wywolanie do terminala AKTYWNEJ zakladki. Dzieki temu wszystkie istniejace
// miejsca (term.write / term.focus / term.reset / term.cols) dzialaja bez zmian,
// a przelaczenie zakladki automatycznie przekierowuje je gdzie indziej.

const TERM_OPTIONS = {
  cursorBlink: true,
  fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 5000,
  // Paleta startowa (cyberpunk); motyw moze ja nadpisac przez term.options.theme.
  theme: {
    background: '#0c0912',
    foreground: '#e6dcff',
    cursor: '#c774ff',
    selectionBackground: '#3a2a5a',
    black: '#1a1424',
    brightBlack: '#4a3a63',
    magenta: '#c774ff',
    brightMagenta: '#e29bff',
    cyan: '#5ff2d6',
    brightCyan: '#8ffbe6',
    green: '#7CFF9B',
    yellow: '#ffd86b',
    red: '#ff6b8a',
  },
};

const termHost = document.getElementById('terminal');
const tabsList = document.getElementById('tabs-list');
const tabNewBtn = document.getElementById('tab-new');

/** id sesji -> { term, fitAddon, el, sparkBuf, lastCtx, ledState, ledDead, alive } */
const termsBySession = new Map();
let activeSessionId = null;
// Ostatnio ustawiona paleta xterm z motywu - nowe zakladki musza ja dostac
// od razu, inaczej rodzilyby sie w domyslnym cyberpunku mimo innego motywu.
let currentTermTheme = null;

/** Tworzy (lub zwraca istniejacy) terminal dla danej sesji. */
function ensureTerm(sessionId) {
  let s = termsBySession.get(sessionId);
  if (s) return s;

  const el = document.createElement('div');
  el.className = 'terminal__pane';
  termHost.appendChild(el);

  const instance = new Terminal(TERM_OPTIONS);
  const addon = new FitAddon.FitAddon();
  instance.loadAddon(addon);
  instance.open(el);
  if (currentTermTheme) {
    instance.options.theme = { ...instance.options.theme, ...currentTermTheme };
  }
  // ACTION INJECTOR: klawisze z TEGO terminala ida do JEGO wlasnego PTY.
  instance.onData((data) => window.lunacore.write(data, sessionId));

  s = {
    term: instance,
    fitAddon: addon,
    el,
    sparkBuf: [],
    lastCtx: null,
    ledState: 'waiting',
    ledDead: false,
    alive: true,
  };
  termsBySession.set(sessionId, s);
  return s;
}

/** Fasada kierujaca do terminala aktywnej zakladki (patrz komentarz wyzej). */
const term = {
  get _t() {
    const s = activeSessionId ? termsBySession.get(activeSessionId) : null;
    return s ? s.term : null;
  },
  write(data) { const x = this._t; if (x) x.write(data); },
  reset() { const x = this._t; if (x) x.reset(); },
  focus() { const x = this._t; if (x) x.focus(); },
  get cols() { const x = this._t; return x ? x.cols : 80; },
  get rows() { const x = this._t; return x ? x.rows : 24; },
  get options() { const x = this._t; return x ? x.options : {}; },
};

/** Nowa paleta xterm z motywu -> na WSZYSTKIE zakladki, nie tylko widoczna. */
function applyTerminalTheme(palette) {
  if (!palette) return;
  currentTermTheme = palette;
  for (const s of termsBySession.values()) {
    s.term.options = { ...s.term.options, theme: { ...s.term.options.theme, ...palette } };
  }
}

// Dopasuj AKTYWNY terminal do kontenera i zsynchronizuj rozmiar jego PTY.
// Zakladki w tle maja zerowe wymiary (display:none), wiec fit() dalby im
// bezsensowne 1x1 - dostana swoj rozmiar przy pierwszym pokazaniu.
function fitAndResize() {
  const s = activeSessionId ? termsBySession.get(activeSessionId) : null;
  if (!s) return;
  try {
    s.fitAddon.fit();
    window.lunacore.resize(s.term.cols, s.term.rows, activeSessionId);
  } catch (err) {
    // Ignoruj bledy dopasowania, gdy okno jest chwilowo o zerowym rozmiarze.
  }
}

// ---- Rozglaszanie metryk do konsumentow aktywnej zakladki -------------------
//
// Nizej w pliku sa dwa niezalezne odbiorniki metryk kontekstu (pasek Fazy 3 i
// sparkline). Rejestrujemy JEDEN nasluch IPC i rozsylamy im wylacznie zdarzenia
// aktywnej zakladki - dane sesji w tle ladują do jej wlasnego kubelka.
const ctxSubscribers = [];
function onActiveContext(cb) { ctxSubscribers.push(cb); }

const restartSubscribers = [];
function onSessionRestarted(cb) { restartSubscribers.push(cb); }

// ---- Spiecie z PTY (routing po sessionId) -----------------------------------

// PASSIVE OBSERVER: dane z procesu Claude CLI -> ekran WLASCIWEJ zakladki.
window.lunacore.onData(({ sessionId, data }) => {
  const s = ensureTerm(sessionId);
  s.term.write(data);
  // LED opisuje to, na co patrzysz. Zakladka w tle miga wlasnym znacznikiem.
  if (sessionId === activeSessionId) markWorking();
  else s.ledState = 'working';
});

// Status polaczenia PTY danej zakladki.
window.lunacore.onExit(({ sessionId, code }) => {
  const s = ensureTerm(sessionId);
  s.alive = false;
  s.ledDead = true;
  s.ledState = 'dead';
  s.term.write(`\r\n\x1b[38;5;203m${t('log.session.ended', { code })}\x1b[0m\r\n`);
  if (sessionId === activeSessionId) {
    setLedDead();
    setPtyStatus(false, 'ptystatus.ended', { code });
  }
  renderTabs();
});

// Metryki kontekstu: KAZDA zakladka ma swoje wlasne okno 200k.
window.lunacore.onContext(({ sessionId, metrics }) => {
  const s = ensureTerm(sessionId);
  if (!metrics || typeof metrics.percent !== 'number') return;
  if (sessionId === activeSessionId) {
    for (const cb of ctxSubscribers) cb(metrics);
  } else {
    // Sesja w tle: zbieramy do jej kubelka, zeby po przelaczeniu pasek i
    // sparkline pokazaly jej wlasna historie, a nie cudza.
    s.lastCtx = metrics;
    const prev = s.sparkBuf[s.sparkBuf.length - 1];
    if (prev && prev.tokens === metrics.tokens) prev.t = Date.now();
    else s.sparkBuf.push({ t: Date.now(), tokens: metrics.tokens, percent: metrics.percent });
    if (s.sparkBuf.length > SPARK_MAX) s.sparkBuf.shift();
  }
  renderTabs();
});

// Kafelki Skill Trackera sa chwilowe - pokazujemy tylko dla aktywnej zakladki.
window.lunacore.onTools(({ sessionId, tiles }) => {
  if (sessionId !== activeSessionId) return;
  lightTiles(tiles);
});

// Restart (zmiana profilu/projektu) dotyczy konkretnej zakladki.
window.lunacore.onRestarted((profile) => {
  const sessionId = profile.sessionId;
  const s = termsBySession.get(sessionId);
  if (s) {
    s.term.reset();
    s.sparkBuf = [];
    s.lastCtx = null;
    s.ledDead = false;
    s.ledState = 'waiting';
    s.alive = true;
    const msg = profile.folder
      ? t('log.session.project', { label: profile.label, folder: profile.folder })
      : t('log.session.switched', { label: profile.label });
    s.term.write(`\x1b[38;5;80m${msg}\x1b[0m\r\n`);
  }
  if (sessionId === activeSessionId) {
    ledDead = false;
    ledState = 'waiting';
    renderLed();
    setPtyStatus(true, 'ptystatus.active');
    for (const cb of restartSubscribers) cb(profile);
    fitAndResize();
    term.focus();
  }
});

// ---- Pasek zakladek ---------------------------------------------------------

let sessionList = [];

/** Przenosi metryki miedzy globalami widoku a kubelkiem zakladki. */
function stashActive() {
  const s = activeSessionId ? termsBySession.get(activeSessionId) : null;
  if (!s) return;
  s.sparkBuf = sparkBuf;
  s.lastCtx = lastCtxMetrics;
  s.ledState = ledState;
  s.ledDead = ledDead;
}

function restoreActive() {
  const s = activeSessionId ? termsBySession.get(activeSessionId) : null;
  if (!s) return;
  sparkBuf = s.sparkBuf || [];
  lastCtxMetrics = s.lastCtx || null;
  ledState = s.ledState || 'waiting';
  ledDead = !!s.ledDead;
  renderLed();
  setPtyStatus(s.alive, s.alive ? 'ptystatus.active' : 'ptystatus.ended', { code: 0 });
  if (lastCtxMetrics) applyCtxMetrics(lastCtxMetrics, false);
  else resetCtxUI();
  renderSpark();
  renderBurn();
}

/** Pokazuje wybrana zakladke; procesy pozostalych zyja dalej w tle. */
function showSession(sessionId) {
  if (!sessionId || sessionId === activeSessionId) return;
  stashActive();
  activeSessionId = sessionId;
  for (const [id, s] of termsBySession) s.el.classList.toggle('is-active', id === sessionId);
  restoreActive();
  syncSwitchers();
  renderTabs();
  fitAndResize(); // zakladka w tle nie znala swojego rozmiaru
  term.focus();
}

/** Ustawia przelaczniki profilu/projektu na wartosci AKTYWNEJ zakladki. */
function syncSwitchers() {
  const meta = sessionList.find((x) => x.id === activeSessionId);
  if (!meta) return;
  if (meta.profileId) profileSwitcher.value = meta.profileId;
  if (meta.projectId) projectSwitcher.value = meta.projectId;
}

function renderTabs() {
  tabsList.innerHTML = '';
  for (const meta of sessionList) {
    const s = termsBySession.get(meta.id);
    const tab = document.createElement('div');
    tab.className = 'tab' + (meta.id === activeSessionId ? ' is-active' : '');
    if (s && !s.alive) tab.classList.add('is-dead');

    const btn = document.createElement('button');
    btn.className = 'tab__label';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(meta.id === activeSessionId));
    btn.textContent = meta.folder || meta.profileLabel || meta.id;
    btn.title = `${meta.profileLabel || ''} - ${meta.cwd || ''}`.trim();
    btn.addEventListener('click', () => window.lunacore.activateSession(meta.id));
    tab.appendChild(btn);

    // Znacznik zapelnienia kontekstu TEJ zakladki - widac zagrozenie w tle.
    const pct = s && s.lastCtx ? Math.round(s.lastCtx.percent * 100) : null;
    if (pct !== null) {
      const dot = document.createElement('span');
      dot.className = 'tab__ctx';
      if (pct >= CTX_WARN_HIGH * 100) dot.classList.add('is-high');
      else if (pct >= CTX_WARN_MID * 100) dot.classList.add('is-mid');
      dot.textContent = `${pct}%`;
      tab.appendChild(dot);
    }

    const close = document.createElement('button');
    close.className = 'tab__close';
    close.textContent = '×';
    close.title = t('tabs.close');
    close.setAttribute('aria-label', t('tabs.close'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.lunacore.closeSession(meta.id);
    });
    tab.appendChild(close);

    tabsList.appendChild(tab);
  }
}

// Lista zakladek z procesu glownego - zrodlo prawdy o tym, co zyje.
window.lunacore.onSessions(({ sessions, activeSessionId: activeId }) => {
  sessionList = sessions || [];
  for (const meta of sessionList) {
    const s = ensureTerm(meta.id);
    s.alive = meta.alive;
  }
  // Sprzataj terminale sesji, ktorych juz nie ma.
  for (const [id, s] of [...termsBySession]) {
    if (sessionList.some((m) => m.id === id)) continue;
    s.term.dispose();
    s.el.remove();
    termsBySession.delete(id);
  }
  if (activeId && activeId !== activeSessionId) {
    if (activeSessionId === null) {
      // Pierwsze rozglosienie: nie ma czego zapisywac, tylko pokaz.
      activeSessionId = activeId;
      for (const [id, s] of termsBySession) s.el.classList.toggle('is-active', id === activeId);
      restoreActive();
      syncSwitchers();
      fitAndResize();
    } else {
      showSession(activeId);
    }
  }
  renderTabs();
});

tabNewBtn.addEventListener('click', () => window.lunacore.createSession({}));

// ---- Przycisk COMPACT CONTEXT (Faza 2) --------------------------------------

const compactBtn = document.getElementById('btn-compact');
compactBtn.addEventListener('click', () => {
  // Wysyla dokladnie "/compact" + Enter do aktywnej sesji - zero dodatkowych tokenow.
  window.lunacore.runCommand('/compact');
  pulse(compactBtn);
  term.focus();
});

// Krotka wizualna informacja zwrotna po kliknieciu.
function pulse(el) {
  el.classList.remove('is-pulsing');
  // wymus reflow, aby animacja odpalila sie ponownie
  void el.offsetWidth;
  el.classList.add('is-pulsing');
}

// ---- LED: pracuje vs czeka na Ciebie ----------------------------------------
//
// PASSIVE OBSERVER w najczystszej postaci - zero nowych kanalow, zero tokenow.
// Sygnal jest juz w strumieniu: TUI Claude Code leje stdout, dopoki mysli
// (spinner, tokeny, wynik narzedzia), a milknie, gdy czeka na wejscie.
// Wiec: dane = pracuje, cisza dluzsza niz prog = tura po Twojej stronie.
//
// Prog swiadomie > niz klatka spinnera, zeby LED nie migotal miedzy stanami.
const LED_IDLE_MS = 800;

const led = document.getElementById('led');
const ledLabel = document.getElementById('led-label');
let ledTimer = null;
let ledDead = false;
let ledState = 'waiting'; // 'working' | 'waiting' | 'dead' - etykiete daje i18n

// Rysuje LED wg stanu (napis pobierany z i18n, wiec zmiana jezyka go odswieza).
function renderLed() {
  led.className = `led led--${ledState}`;
  ledLabel.textContent = t(`led.${ledState}`);
}

// Wywolywane przy kazdej porcji stdout; timer przesuwa sie do przodu.
function markWorking() {
  if (ledDead) return;
  ledState = 'working';
  renderLed();
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => {
    ledState = 'waiting';
    renderLed();
  }, LED_IDLE_MS);
}

function setLedDead() {
  ledDead = true;
  clearTimeout(ledTimer);
  ledState = 'dead';
  renderLed();
}

// ---- Faza 3: Context Window (transcript JSONL) ------------------------------

const ctxFill = document.getElementById('ctx-fill');
const ctxPercent = document.getElementById('ctx-percent');
const ctxWarn = document.getElementById('ctx-warn');
const ctxTokens = document.getElementById('ctx-tokens');
const ctxModel = document.getElementById('ctx-model');

// Progi kolorow paska: < 60% zielony, 60-85% zolty, > 85% czerwony + alarm.
const CTX_WARN_HIGH = 0.85;
const CTX_WARN_MID = 0.6;

let lastCtxMetrics = null; // trzymamy ostatnie metryki, by odswiezyc napis po zmianie jezyka

// Rysuje pasek kontekstu. `live` = swieza metryka (moze uzbroic auto-compact);
// przy zwyklym przelaczeniu zakladki tylko odtwarzamy widok, nic nie strzela.
function applyCtxMetrics(metrics, live = true) {
  if (!metrics || typeof metrics.percent !== 'number') return;
  lastCtxMetrics = metrics;
  const pct = Math.max(0, Math.min(1, metrics.percent));

  // Pasek: scaleX 0..1 (bez layout thrash) + kolor zalezny od progu.
  ctxFill.style.setProperty('--ctx', pct.toFixed(3));
  ctxFill.classList.toggle('is-mid', pct >= CTX_WARN_MID && pct < CTX_WARN_HIGH);
  ctxFill.classList.toggle('is-high', pct >= CTX_WARN_HIGH);

  ctxPercent.textContent = `${Math.round(pct * 100)}%`;
  renderModelBadge(metrics);
  renderCtxText();
  if (live) maybeAutoCompact(pct);
}

/** Formatuje okno kontekstu do postaci "200k" / "1M". */
function formatLimit(limit) {
  if (!limit || typeof limit !== 'number') return '';
  return limit >= 1000000 ? `${limit / 1000000}M` : `${Math.round(limit / 1000)}k`;
}

/**
 * Plakietka modelu (B3) wraz z wykrytym oknem kontekstu (B2).
 * Okno pokazujemy CELOWO: skoro limit nie jest juz stala, to bez tego napisu
 * awans 200k -> 1M byloby niewidoczny i nie do zweryfikowania okiem.
 * Brak modelu (swieza sesja, lokalny backend bez pola model) => chowamy
 * plakietke zamiast pokazywac pusty dymek.
 */
function renderModelBadge(metrics) {
  if (!ctxModel) return;
  const label = (metrics && metrics.modelLabel) || '';
  if (!label) {
    ctxModel.hidden = true;
    ctxModel.textContent = '';
    ctxModel.removeAttribute('title');
    return;
  }
  const limit = formatLimit(metrics.limit);
  ctxModel.textContent = limit ? `${label} · ${limit}` : label;
  // Pelne id modelu w dymku - etykieta jest skrocona, oryginal bywa potrzebny.
  ctxModel.title = metrics.model || label;
  ctxModel.hidden = false;
}

/** Czysci pasek, gdy zakladka nie ma jeszcze zadnych metryk. */
function resetCtxUI() {
  lastCtxMetrics = null;
  ctxFill.style.setProperty('--ctx', '0');
  ctxFill.classList.remove('is-mid', 'is-high');
  ctxPercent.textContent = '0%';
  ctxWarn.textContent = '';
  ctxTokens.textContent = '';
  renderModelBadge(null);
}

onActiveContext((metrics) => applyCtxMetrics(metrics, true));

// Napisy tekstowe context window (ostrzezenie + tokeny) - i18n-aware.
function renderCtxText() {
  if (!lastCtxMetrics) return;
  const pct = Math.max(0, Math.min(1, lastCtxMetrics.percent));
  ctxWarn.textContent = pct >= CTX_WARN_HIGH ? t('ctx.warn.compact') : '';
  const k = (n) => `${Math.round(n / 1000)}k`;
  ctxTokens.textContent = t('ctx.tokens', {
    used: k(lastCtxMetrics.tokens),
    limit: k(lastCtxMetrics.limit),
  });
}

// ---- Uzbrojony auto-compact (§5.5) ------------------------------------------
//
// Toggle w sekcji Akcje. Gdy UZBROJONY i kontekst przekroczy prog, renderer sam
// wstrzykuje "/compact" przez ISTNIEJACY Action Injector (runCommand) - zero
// nowych kanalow IPC. Sam /compact kosztuje tokeny, ale to koszt jawny i
// swiadomie uzbrojony przez uzytkownika (domyslnie OFF).
//
// Wyzwalacz zboczowy z histereza: strzela RAZ, gdy kontekst przekroczy AT (85%),
// i uzbraja sie ponownie dopiero, gdy spadnie ponizej REARM (60%) - inaczej po
// compakcie oscylowalby wokol progu i spamowal. Dodatkowy cooldown to pas
// bezpieczenstwa, gdyby metryka byla chwilowo szumna tuz po compakcie.
const AUTO_COMPACT_AT = CTX_WARN_HIGH;      // prog wyzwolenia (0.85)
const AUTO_COMPACT_REARM = CTX_WARN_MID;    // ponizej tego znow gotowy (0.60)
const AUTO_COMPACT_COOLDOWN_MS = 60000;     // nigdy dwa razy w ciagu 60 s

const autoCompactToggle = document.getElementById('autocompact-toggle');
const autoCompactStatus = document.getElementById('autocompact-status');
const autoCompactField = document.getElementById('autocompact-field');

let autoCompactArmed = false;   // stan togglea (domyslnie OFF, nietrwaly - swiadome uzbrojenie co sesje)
let autoCompactFired = false;   // flaga zbocza: juz strzelilismy w tym cyklu
let autoCompactFiredAt = 0;     // znacznik ostatniego strzalu (cooldown)
let autoCompactFlashTimer = null;

function maybeAutoCompact(pct) {
  if (!autoCompactArmed) return;
  // Histereza: po spadku ponizej progu ponownego uzbrojenia kasujemy zbocze.
  if (pct < AUTO_COMPACT_REARM) autoCompactFired = false;
  if (pct < AUTO_COMPACT_AT || autoCompactFired) return;
  if (ledDead) return; // martwa sesja - nie ma gdzie wstrzykiwac
  if (Date.now() - autoCompactFiredAt < AUTO_COMPACT_COOLDOWN_MS) return;

  autoCompactFired = true;
  autoCompactFiredAt = Date.now();
  window.lunacore.runCommand('/compact'); // ten sam injector co fizyczny przycisk
  pulse(compactBtn);
  flashAutoCompactFired();
}

// Krotki blysk statusu "wyslano /compact", potem powrot do "uzbrojone".
function flashAutoCompactFired() {
  clearTimeout(autoCompactFlashTimer);
  autoCompactField.classList.add('is-fired');
  autoCompactStatus.textContent = t('autocompact.fired');
  autoCompactFlashTimer = setTimeout(() => {
    autoCompactField.classList.remove('is-fired');
    renderAutoCompact();
  }, 2500);
}

// Odswieza etykiete statusu wg stanu (i18n-aware, wolane tez przy zmianie jezyka).
function renderAutoCompact() {
  if (autoCompactField.classList.contains('is-fired')) return; // nie nadpisuj blysku
  autoCompactStatus.textContent = autoCompactArmed ? t('autocompact.armed') : t('autocompact.off');
}

autoCompactToggle.addEventListener('change', () => {
  autoCompactArmed = autoCompactToggle.checked;
  autoCompactFired = false; // przy (roz)uzbrojeniu zaczynamy cykl od nowa
  autoCompactField.classList.toggle('is-armed', autoCompactArmed);
  renderAutoCompact();
});

// ---- Faza 3: Skill Tracker (nazwy narzedzi ze stdout) -----------------------

// Kafelek zapala sie po wykryciu narzedzia i gasnie po chwili bezczynnosci.
const TILE_ACTIVE_MS = 1500;
const tileTimers = new Map();

function lightTiles(tiles) {
  if (!Array.isArray(tiles)) return;
  for (const name of tiles) {
    const tile = document.querySelector(`.skill-tile[data-skill="${name}"]`);
    if (!tile) continue;
    tile.classList.add('is-active');
    // Odswiez timer wygaszenia (kolejne wykrycie przedluza swiecenie).
    clearTimeout(tileTimers.get(name));
    tileTimers.set(
      name,
      setTimeout(() => tile.classList.remove('is-active'), TILE_ACTIVE_MS)
    );
  }
}

// ---- Faza 4: Przelacznik profili --------------------------------------------

const profileSwitcher = document.getElementById('profile-switcher');

// Wypelnij liste profilami z config/ i zaznacz aktywny.
async function initProfiles() {
  try {
    const { profiles, activeProfile } = await window.lunacore.getProfiles();
    profileSwitcher.innerHTML = '';
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === activeProfile) opt.selected = true;
      profileSwitcher.appendChild(opt);
    }
  } catch (err) {
    // Gdy nie uda sie pobrac profili - zostaw przelacznik pusty (nieblokujace).
  }
}

// Zmiana profilu -> restart TEJ zakladki; pozostale sesje zostaja nietkniete.
profileSwitcher.addEventListener('change', () => {
  window.lunacore.switchProfile(profileSwitcher.value, activeSessionId);
});

initProfiles();

// ---- Przelacznik projektu (katalog roboczy) ---------------------------------

const projectSwitcher = document.getElementById('project-switcher');

// Wypelnij liste katalogami z config/projects.json i zaznacz aktywny.
async function initProjects() {
  try {
    const { projects, activeProject } = await window.lunacore.getProjects();
    projectSwitcher.innerHTML = '';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === activeProject) opt.selected = true;
      projectSwitcher.appendChild(opt);
    }
  } catch (err) {
    // Nie udalo sie pobrac projektow - zostaw przelacznik pusty (nieblokujace).
  }
}

// Zmiana katalogu -> restart sesji PTY w nowym folderze (ten sam profil).
projectSwitcher.addEventListener('change', () => {
  window.lunacore.switchProject(projectSwitcher.value, activeSessionId);
});

initProjects();

// ---- 7B: Tracker portow localhost -------------------------------------------

const portsList = document.getElementById('ports-list');
const portsEmpty = document.getElementById('ports-empty');

// Buduje jeden przycisk akcji (bezpiecznie, bez wstrzykiwania HTML).
function portButton(label, act, title, dataset) {
  const b = document.createElement('button');
  b.className = act === 'kill' ? 'port-btn port-btn--kill' : 'port-btn';
  b.textContent = label;
  b.title = title;
  b.dataset.act = act;
  Object.assign(b.dataset, dataset);
  return b;
}

window.lunacore.onPorts((ports) => {
  portsList.innerHTML = '';
  portsEmpty.style.display = ports.length ? 'none' : '';
  if (!ports.length) {
    portsEmpty.textContent = t('ports.empty');
    return;
  }
  for (const p of ports) {
    const li = document.createElement('li');
    li.className = 'port-item';

    const port = document.createElement('span');
    port.className = 'port-item__port';
    port.textContent = p.port;

    const proc = document.createElement('span');
    proc.className = 'port-item__proc';
    proc.textContent = `${p.name} · ${p.procId}`;
    proc.title = `PID ${p.procId}`;

    const actions = document.createElement('span');
    actions.className = 'port-item__actions';
    actions.appendChild(portButton('↗', 'open', t('ports.open.title'), { port: p.port }));
    actions.appendChild(portButton('⧉', 'copy', t('ports.copy.title'), { port: p.port }));
    actions.appendChild(
      portButton('✕', 'kill', t('ports.kill.title'), { pid: p.procId, name: p.name, port: p.port })
    );

    li.append(port, proc, actions);
    portsList.appendChild(li);
  }
});

// Delegacja akcji: otworz / kopiuj / kill.
portsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.port-btn');
  if (!btn) return;
  const { act, port, pid, name } = btn.dataset;
  if (act === 'open') {
    window.lunacore.openPort(Number(port));
  } else if (act === 'copy') {
    navigator.clipboard.writeText(`http://localhost:${port}`).catch(() => {});
    pulse(btn);
  } else if (act === 'kill') {
    if (!confirm(t('ports.kill.confirm', { name, pid, port }))) return;
    await window.lunacore.killPort(Number(pid));
  }
});

// ---- 7C: Sciagawki akcji (zwijki + przyciski komend) ------------------------

const cheatsContainer = document.getElementById('cheatsheets');

async function initCheatsheets() {
  let data;
  try {
    data = await window.lunacore.getCheatsheets();
  } catch {
    return; // brak configu - sekcja zostaje pusta
  }
  const groups = (data && data.groups) || [];
  cheatsContainer.innerHTML = '';
  groups.forEach((group, i) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    if (i === 0) details.open = true; // pierwsza grupa rozwinieta

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = group.title;
    details.appendChild(summary);

    if (group.note) {
      const note = document.createElement('p');
      note.className = 'cheat__note';
      note.textContent = group.note;
      details.appendChild(note);
    }

    const cmds = document.createElement('div');
    cmds.className = 'cheat__cmds';
    for (const c of group.commands) {
      const btn = document.createElement('button');
      btn.className = 'cheat__btn';
      btn.textContent = c.label;
      btn.title = c.command; // pelna komenda w tooltipie
      btn.dataset.cmd = c.command;
      cmds.appendChild(btn);
    }
    details.appendChild(cmds);
    cheatsContainer.appendChild(details);
  });
}

// Delegacja: klik przycisku = wstrzykniecie komendy do PTY (Action Injector).
cheatsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.cheat__btn');
  if (!btn) return;
  window.lunacore.runCommand(btn.dataset.cmd);
  pulse(btn);
  term.focus();
});

initCheatsheets();

// ---- Biblioteka promptow (wielolinijkowe, wklejane) -------------------------

const promptsContainer = document.getElementById('prompts');

// Prompty trzymamy tutaj (dataset w DOM nie znosi wielolinijkowego tekstu
// dobrze); przycisk niesie tylko indeks "grupa:prompt".
const promptIndex = new Map();

async function initPrompts() {
  let data;
  try {
    data = await window.lunacore.getPrompts();
  } catch {
    return; // brak configu - sekcja zostaje pusta
  }
  const groups = (data && data.groups) || [];
  promptsContainer.innerHTML = '';
  promptIndex.clear();

  groups.forEach((group, gi) => {
    const details = document.createElement('details');
    details.className = 'cheat';
    if (gi === 0) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = group.title;
    details.appendChild(summary);

    if (group.note) {
      const note = document.createElement('p');
      note.className = 'cheat__note';
      note.textContent = group.note;
      details.appendChild(note);
    }

    const list = document.createElement('div');
    list.className = 'prompt-list';

    group.prompts.forEach((p, pi) => {
      const key = `${gi}:${pi}`;
      promptIndex.set(key, p.text);

      const row = document.createElement('div');
      row.className = 'prompt-row';

      // Glowny przycisk: wkleja prompt BEZ wyslania (mozna dopisac szczegoly).
      const insert = document.createElement('button');
      insert.className = 'prompt-btn';
      insert.textContent = p.label;
      insert.title = p.note ? `${p.note}\n\n${p.text}` : p.text;
      insert.dataset.key = key;
      insert.dataset.act = 'insert';

      // Maly przycisk: wklej i od razu wyslij.
      const send = document.createElement('button');
      send.className = 'prompt-send';
      send.textContent = '⏎';
      send.title = 'Wklej i wyslij od razu';
      send.dataset.key = key;
      send.dataset.act = 'send';

      row.append(insert, send);
      list.appendChild(row);
    });

    details.appendChild(list);
    promptsContainer.appendChild(details);
  });
}

// Delegacja: wklejenie prompta do sesji przez Action Injector (bracketed paste).
promptsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.prompt-btn, .prompt-send');
  if (!btn) return;
  const text = promptIndex.get(btn.dataset.key);
  if (typeof text !== 'string') return;
  window.lunacore.pastePrompt(text, btn.dataset.act === 'send');
  pulse(btn);
  term.focus();
});

initPrompts();

// ---- 7A: Sciagawka skilli wg kategorii --------------------------------------

const skillsContainer = document.getElementById('skills');
const skillsCount = document.getElementById('skills-count');

async function initSkills() {
  let data;
  try {
    data = await window.lunacore.getSkills();
  } catch {
    return;
  }
  const categories = (data && data.categories) || [];
  skillsCount.textContent = data && data.total ? `(${data.total})` : '';
  skillsContainer.innerHTML = '';

  for (const cat of categories) {
    const details = document.createElement('details');
    details.className = 'cheat';

    const summary = document.createElement('summary');
    summary.className = 'cheat__summary';
    summary.textContent = `${cat.name} · ${cat.skills.length}`;
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'skill-cat';
    for (const s of cat.skills) {
      const item = document.createElement('button');
      item.className = 'skill-entry';
      item.textContent = s.name;
      item.title = s.description || s.name; // pelny opis w tooltipie
      item.dataset.name = s.name;
      list.appendChild(item);
    }
    details.appendChild(list);
    skillsContainer.appendChild(details);
  }
}

// Klik skilla = kopiuj jego nazwe do schowka (do wklejenia / wywolania).
skillsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.skill-entry');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.name).catch(() => {});
  pulse(btn);
});

initSkills();

// ---- Brudnopis (lokalny notatnik) -------------------------------------------

const padText = document.getElementById('pad-text');
const padStatus = document.getElementById('pad-status');
const padSend = document.getElementById('pad-send');

// Autozapis po chwili bezczynnosci - nie na kazdym klawiszu.
const PAD_SAVE_MS = 500;
let padTimer = null;

window.lunacore
  .getScratchpad()
  .then((text) => {
    padText.value = typeof text === 'string' ? text : '';
  })
  .catch(() => {
    // brak pliku / blad odczytu - zostaw pusty notatnik (nieblokujace)
  });

padText.addEventListener('input', () => {
  padStatus.textContent = '·';
  clearTimeout(padTimer);
  padTimer = setTimeout(async () => {
    const ok = await window.lunacore.saveScratchpad(padText.value);
    padStatus.textContent = ok ? t('pad.saved') : t('pad.saveError');
  }, PAD_SAVE_MS);
});

// Wklejenie notatek do sesji: bez wysylania, zeby dalo sie jeszcze dopisac.
padSend.addEventListener('click', () => {
  const text = padText.value.trim();
  if (!text) return;
  window.lunacore.pastePrompt(text, false);
  pulse(padSend);
  term.focus();
});

// ---- Paleta komend (Ctrl+K) -------------------------------------------------
//
// Klawiaturowy agregat WSZYSTKICH wstrzykiwalnych akcji: fizyczny COMPACT,
// sciagawki (7C), prompty i skille. Czysto rendererowa - zero nowych kanalow
// IPC, zero dodatkowych tokenow: kazdy wpis odpala sie dokladnie tak, jak jego
// oryginalny przycisk (runCommand / pastePrompt / kopiuj do schowka).
//
// Enter = akcja glowna wpisu (komenda: wyslij; prompt: wklej bez wysylki;
// skill: kopiuj nazwe). Shift+Enter na promptcie wkleja I wysyla.

const paletteEl = document.getElementById('palette');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
const paletteOpenBtn = document.getElementById('palette-open');

const PALETTE_MAX = 50; // ile wierszy renderujemy (lista skilli bywa 300+)

let paletteItems = null; // leniwie zbudowany, plaski agregat wszystkich akcji
let paletteFiltered = []; // aktualnie widoczne wpisy (po filtrze)
let paletteSel = 0; // indeks zaznaczonego wiersza
let paletteOpen = false;

// Zbiera akcje ze wszystkich zrodel do jednej plaskiej listy `{ kind, label,
// sub, hint, run(opts) }`. Dane pochodza z tych samych mostkow co panele.
async function buildPaletteActions() {
  const items = [];

  // Statyczna akcja: fizyczny przycisk COMPACT.
  items.push({
    kind: 'action',
    label: 'COMPACT CONTEXT',
    sub: t('palette.action.sub'),
    hint: '/compact',
    run: () => window.lunacore.runCommand('/compact'),
  });

  const [cheats, prompts, skills] = await Promise.all([
    window.lunacore.getCheatsheets().catch(() => null),
    window.lunacore.getPrompts().catch(() => null),
    window.lunacore.getSkills().catch(() => null),
  ]);

  for (const g of (cheats && cheats.groups) || []) {
    for (const c of g.commands || []) {
      items.push({
        kind: 'command',
        label: c.label,
        sub: g.title,
        hint: c.command,
        run: () => window.lunacore.runCommand(c.command),
      });
    }
  }

  for (const g of (prompts && prompts.groups) || []) {
    for (const p of g.prompts || []) {
      // Main normalizuje `text` do stringa; join defensywnie na wszelki wypadek.
      const text = Array.isArray(p.text) ? p.text.join('\n') : p.text;
      items.push({
        kind: 'prompt',
        label: p.label,
        sub: g.title,
        hint: t('palette.hint.promptPaste'),
        run: (opts) => window.lunacore.pastePrompt(text, !!(opts && opts.send)),
      });
    }
  }

  for (const cat of (skills && skills.categories) || []) {
    for (const s of cat.skills || []) {
      items.push({
        kind: 'skill',
        label: s.name,
        sub: cat.name,
        hint: t('palette.hint.skillCopy'),
        run: () => navigator.clipboard.writeText(s.name).catch(() => {}),
      });
    }
  }

  return items;
}

// Dopasowanie fuzzy (podciag): zwraca { score, indices } lub null.
// Premiuje trafienia ciagle i na granicy slowa; krotszy tekst wyzej.
function fuzzyMatch(query, text) {
  const tx = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return { score: 0, indices: [] };

  const indices = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  let streak = 0;

  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    for (let k = ti; k < tx.length; k++) {
      if (tx[k] === q[qi]) { found = k; break; }
    }
    if (found === -1) return null;
    indices.push(found);

    if (found === prev + 1) { streak++; score += 5 + streak * 3; }
    else { streak = 0; score += 1; }
    if (found === 0 || /[\s/_\-:.]/.test(tx[found - 1])) score += 8; // start slowa

    prev = found;
    ti = found + 1;
  }

  if (tx.includes(q)) score += 15; // ciagly podciag = mocny bonus
  score -= tx.length * 0.05; // przy remisie krotszy wygrywa
  return { score, indices };
}

// Filtruje i sortuje wpisy dla zapytania. Highlight tylko na etykiecie;
// dopasowanie moze tez wpasc przez `sub`/`hint`, ale z nizszym priorytetem.
function filterPalette(query) {
  const q = query.trim();
  if (!q) return paletteItems.slice(0, PALETTE_MAX).map((item) => ({ item, indices: [] }));

  const scored = [];
  for (const item of paletteItems) {
    const onLabel = fuzzyMatch(q, item.label);
    if (onLabel) {
      scored.push({ item, indices: onLabel.indices, score: onLabel.score + 1000 });
      continue;
    }
    const onMeta = fuzzyMatch(q, `${item.sub} ${item.hint}`);
    if (onMeta) scored.push({ item, indices: [], score: onMeta.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, PALETTE_MAX);
}

// Buduje etykiete z podswietleniem trafionych znakow (bezpiecznie, bez innerHTML).
function labelWithMarks(label, indices) {
  const frag = document.createDocumentFragment();
  const set = new Set(indices);
  let buf = '';
  const flush = (mark) => {
    if (!buf) return;
    if (mark) {
      const m = document.createElement('mark');
      m.textContent = buf;
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(buf));
    }
    buf = '';
  };
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i);
    const prevHit = set.has(i - 1);
    if (i > 0 && hit !== prevHit) flush(prevHit);
    buf += label[i];
  }
  flush(set.has(label.length - 1));
  return frag;
}

function renderPalette() {
  paletteList.innerHTML = '';

  if (!paletteFiltered.length) {
    const empty = document.createElement('li');
    empty.className = 'palette__empty';
    empty.textContent = t('palette.empty');
    paletteList.appendChild(empty);
    return;
  }

  paletteFiltered.forEach(({ item, indices }, i) => {
    const li = document.createElement('li');
    li.className = 'palette-item' + (i === paletteSel ? ' is-active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === paletteSel ? 'true' : 'false');
    li.dataset.idx = i;

    const kind = document.createElement('span');
    kind.className = 'palette-item__kind';
    kind.dataset.kind = item.kind;
    kind.textContent = t(`palette.kind.${item.kind}`);

    const body = document.createElement('span');
    body.className = 'palette-item__body';
    const label = document.createElement('div');
    label.className = 'palette-item__label';
    label.appendChild(labelWithMarks(item.label, indices));
    const sub = document.createElement('div');
    sub.className = 'palette-item__sub';
    sub.textContent = item.sub;
    body.append(label, sub);

    const hint = document.createElement('span');
    hint.className = 'palette-item__hint';
    hint.textContent = item.hint;

    li.append(kind, body, hint);
    paletteList.appendChild(li);
  });
}

// Trzyma zaznaczenie w zakresie i przewija do widocznego wiersza.
function setPaletteSel(idx) {
  const len = paletteFiltered.length;
  if (!len) return;
  paletteSel = ((idx % len) + len) % len; // zawijanie gora/dol
  renderPalette();
  const active = paletteList.querySelector('.palette-item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function updatePalette() {
  paletteFiltered = filterPalette(paletteInput.value);
  paletteSel = 0;
  renderPalette();
}

// Odpala zaznaczony (lub wskazany) wpis i zamyka palete.
function firePalette(idx, opts) {
  const row = paletteFiltered[idx];
  if (!row) return;
  try {
    row.item.run(opts);
  } catch {
    // pojedyncza akcja nie moze wywalic palety
  }
  closePalette();
  term.focus();
}

async function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  paletteEl.hidden = false;

  // Leniwe zbudowanie agregatu przy pierwszym otwarciu (getSkills bywa wolne,
  // ale main cache'uje je na sesje). Kolejne otwarcia sa natychmiastowe.
  if (!paletteItems) {
    paletteItems = [];
    try {
      paletteItems = await buildPaletteActions();
    } catch {
      paletteItems = [];
    }
  }

  paletteInput.value = '';
  updatePalette();
  paletteInput.focus();
}

function closePalette() {
  if (!paletteOpen) return;
  paletteOpen = false;
  paletteEl.hidden = true;
}

// Klawiatura wewnatrz pola wyszukiwania.
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSel(paletteSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteSel(paletteSel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); firePalette(paletteSel, { send: e.shiftKey }); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); term.focus(); }
});

paletteInput.addEventListener('input', updatePalette);

// Mysz: hover zaznacza, klik odpala (Shift+klik wysyla prompt).
paletteList.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.palette-item');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (idx !== paletteSel) { paletteSel = idx; renderPalette(); }
});
paletteList.addEventListener('click', (e) => {
  const row = e.target.closest('.palette-item');
  if (!row) return;
  firePalette(Number(row.dataset.idx), { send: e.shiftKey });
});

// Klik w tlo zamyka.
paletteEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-palette-close')) { closePalette(); term.focus(); }
});

// Chip w pasku terminala otwiera palete.
if (paletteOpenBtn) paletteOpenBtn.addEventListener('click', openPalette);

// Globalny skrot Ctrl/Cmd+K (capture, by wyprzedzic terminal xterm.js).
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      if (paletteOpen) { closePalette(); term.focus(); }
      else openPalette();
    }
  },
  true
);

// ---- Sparkline burn-rate (context window w czasie) --------------------------
//
// PASSIVE OBSERVER: te same probki `usage`, ktore zasilaja pasek Context Window,
// tyle ze zapamietane w czasie. Widac, jak kontekst pelznie ku compactowi -
// plus tempo (tok/min) i szacowany czas do progu 85%. Zero nowych kanalow IPC
// (dopinamy sie drugim listenerem `onContext`), zero dodatkowych tokenow.

const sparkLine = document.getElementById('ctx-spark-line');
const sparkArea = document.getElementById('ctx-spark-area');
const ctxBurn = document.getElementById('ctx-burn');

const SPARK_MAX = 80; // ile probek trzymamy na wykresie
const BURN_WINDOW_MS = 5 * 60 * 1000; // okno liczenia tempa (5 min)

let sparkBuf = []; // [{ t, tokens, percent }]

// Rysuje linie + wypelnienie w ukladzie viewBox 0..100 (x) / 0..30 (y, odwrocony).
function renderSpark() {
  const n = sparkBuf.length;
  if (n < 2) {
    sparkLine.setAttribute('points', '');
    sparkArea.setAttribute('d', '');
    return;
  }
  const pts = sparkBuf.map((s, i) => {
    const x = (i / (n - 1)) * 100;
    const y = (1 - Math.max(0, Math.min(1, s.percent))) * 30;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  sparkLine.setAttribute('points', pts.join(' '));
  sparkArea.setAttribute('d', `M0,30 L${pts.join(' L')} L100,30 Z`);
}

// Formatuje tempo: ponizej 1k jako liczba, wyzej jako "1.8k".
function fmtRate(r) {
  const a = Math.abs(r);
  return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
}

// Liczy tempo z okna czasowego i wypisuje tekst + ETA do progu 85%.
function renderBurn() {
  const n = sparkBuf.length;
  if (n < 2) {
    ctxBurn.textContent = t('burn.collecting');
    return;
  }
  const last = sparkBuf[n - 1];
  // Najstarsza probka mieszczaca sie w oknie BURN_WINDOW_MS.
  let first = sparkBuf[0];
  for (const s of sparkBuf) {
    if (last.t - s.t <= BURN_WINDOW_MS) { first = s; break; }
  }
  const dtMin = (last.t - first.t) / 60000;
  if (dtMin <= 0) { ctxBurn.textContent = '—'; return; }

  const rate = (last.tokens - first.tokens) / dtMin; // tokeny / min
  if (rate > 5) {
    const thresholdTokens = CTX_WARN_HIGH * last.limit;
    const remaining = thresholdTokens - last.tokens;
    let eta;
    if (remaining > 0) {
      const min = remaining / rate;
      eta = t('burn.eta.to85', { min: min < 1 ? '<1' : Math.round(min) });
    } else {
      eta = t('burn.eta.zone');
    }
    ctxBurn.textContent = t('burn.up', { rate: fmtRate(rate), eta });
  } else if (rate < -5) {
    ctxBurn.textContent = t('burn.down', { rate: fmtRate(rate) });
  } else {
    ctxBurn.textContent = t('burn.stable');
  }
}

// Drugi odbiornik metryk - probkuje bez ruszania bloku Fazy 3 wyzej.
onActiveContext((metrics) => {
  if (!metrics || typeof metrics.tokens !== 'number') return;
  const now = Date.now();
  const prev = sparkBuf[sparkBuf.length - 1];
  if (prev && prev.tokens === metrics.tokens) {
    prev.t = now; // ta sama wartosc: odswiez czas, nie mnoz punktow
  } else {
    sparkBuf.push({ t: now, tokens: metrics.tokens, percent: metrics.percent });
    if (sparkBuf.length > SPARK_MAX) sparkBuf.shift();
  }
  renderSpark();
  renderBurn();
});

// Restart sesji = nowy kontekst: czyscimy historie sparkline.
onSessionRestarted(() => {
  sparkBuf = [];
  renderSpark();
  renderBurn();
});

// ---- Licznik zuzycia limitow (5h + tydzien) --------------------------------
//
// Dane z IPC usage:update (odczyt GET z endpointu OAuth CLI - zero tokenow).
// Renderer trzyma ostatni stan i odlicza czas do resetu z resetsAt na biezaco,
// wiec przelaczenie jezyka i tykanie zegara odswiezaja UI bez nowego zapytania.

const usageBody = document.getElementById('usage-body');
const usageRefreshBtn = document.getElementById('usage-refresh');
let lastUsage = null;

// Humanizuje czas do resetu (ISO -> "4d 2h" / "3h 12m" / "9m"). null gdy minal.
function fmtResetWhen(resetsAt) {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Buduje jeden wiersz paska zuzycia (etykieta + pasek + % + czas do resetu).
function usageRow(labelKey, win) {
  const row = document.createElement('div');
  row.className = 'usage-row';

  const head = document.createElement('div');
  head.className = 'usage-row__head';
  const label = document.createElement('span');
  label.className = 'usage-row__label';
  label.textContent = t(labelKey);
  const pct = document.createElement('span');
  pct.className = 'usage-row__pct';
  pct.textContent = `${win.pct}%`;
  head.append(label, pct);

  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  const fill = document.createElement('div');
  fill.className = 'usage-bar__fill';
  // Wypelnienie przez scaleX (--usage 0..1), spojnie z .ctx-bar__fill.
  fill.style.setProperty('--usage', String(win.pct / 100));
  // Prog kolorow: >=90 zle (czerwony), >=70 uwaga (pomaranczowy), reszta ok.
  fill.dataset.level = win.pct >= 90 ? 'bad' : win.pct >= 70 ? 'warn' : 'good';
  bar.appendChild(fill);

  const reset = document.createElement('div');
  reset.className = 'usage-row__reset hint';
  const when = fmtResetWhen(win.resetsAt);
  reset.textContent = when ? t('usage.resetIn', { when }) : t('usage.resetting');

  row.append(head, bar, reset);
  return row;
}

function usageMessage(key) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = t(key);
  return p;
}

// Renderuje kafelek z aktualnego stanu (lastUsage). Stany bledu -> komunikat.
function renderUsage() {
  usageBody.innerHTML = '';
  const u = lastUsage;
  if (!u) {
    usageBody.appendChild(usageMessage('usage.loading'));
    return;
  }
  if (u.error) {
    const key =
      u.error === 'reauth' ? 'usage.reauth' : u.error === 'off' ? 'usage.off' : 'usage.unavailable';
    usageBody.appendChild(usageMessage(key));
    return;
  }
  const windows = [
    ['usage.window.5h', u.fiveHour],
    ['usage.window.week', u.sevenDay],
    ['usage.window.opus', u.sevenDayOpus],
    ['usage.window.sonnet', u.sevenDaySonnet],
  ];
  let any = false;
  for (const [key, win] of windows) {
    if (win && typeof win.pct === 'number') {
      usageBody.appendChild(usageRow(key, win));
      any = true;
    }
  }
  if (!any) {
    usageBody.appendChild(usageMessage('usage.unavailable'));
    return;
  }
  if (u.extraUsage) usageBody.appendChild(usageMessage('usage.extra'));
}

window.lunacore.onUsage((usage) => {
  lastUsage = usage;
  renderUsage();
});

usageRefreshBtn.addEventListener('click', async () => {
  usageRefreshBtn.classList.add('is-spinning');
  try {
    const u = await window.lunacore.refreshUsage();
    if (u) {
      lastUsage = u;
      renderUsage();
    }
  } catch {
    /* ignoruj - watcher i tak wyemituje przy kolejnym ticku */
  } finally {
    setTimeout(() => usageRefreshBtn.classList.remove('is-spinning'), 400);
  }
});

// Odswiezaj etykiety resetu co 30 s (odliczanie liczone z resetsAt lokalnie,
// bez nowego zapytania sieciowego).
setInterval(() => {
  if (lastUsage && !lastUsage.error) renderUsage();
}, 30000);

// ---- Sekwencja startowa (boot) ----------------------------------------------
//
// Czysta ozdoba nad gotowym UI: log "podsystemow", smuga skanujaca i pasek
// postepu. Zero IPC i zero tokenow - caly ruch robi CSS, JS tylko wstawia
// wiersze (przetlumaczone), ustawia kaskade opoznien i sprzata po sobie.
//
// Zasada nadrzedna: NIGDY nie blokuje. PTY startuje i leje stdout pod spodem,
// a klik albo dowolny klawisz natychmiast zdejmuje nakladke. Swiadomie bez
// preventDefault - wcisniety klawisz ma poleciec dalej do terminala, wiec
// "pominiecie" nie gubi pierwszego znaku, ktory wpisujesz.

const BOOT_LINE_KEYS = [
  'boot.line.pty',
  'boot.line.observer',
  'boot.line.injector',
  'boot.line.theme',
  'boot.line.skills',
];
const BOOT_FIRST_LINE_MS = 340; // start kaskady (po odslonieciu znaku firmowego)
const BOOT_LINE_STEP_MS = 120; // odstep miedzy kolejnymi wierszami
const BOOT_HOLD_MS = 1150; // moment automatycznego zejscia nakladki
const BOOT_FADE_MS = 240; // MUSI zgadzac sie z .boot.is-out w styles.css

const bootEl = document.getElementById('boot');
const bootLogEl = document.getElementById('boot-log');
const bootToggle = document.getElementById('boot-toggle');
const bootStatus = document.getElementById('boot-status');
let bootTimers = [];
let bootDone = false;

// Zdejmuje nakladke. Idempotentne - klik i timer moga trafic w to samo miejsce.
function endBoot(instant = false) {
  if (bootDone) return;
  bootDone = true;
  bootTimers.forEach(clearTimeout);
  bootTimers = [];
  document.removeEventListener('keydown', skipBoot, true);
  bootEl.removeEventListener('click', skipBoot);

  if (instant) {
    bootEl.hidden = true;
  } else {
    bootEl.classList.add('is-out');
    bootTimers.push(setTimeout(() => { bootEl.hidden = true; }, BOOT_FADE_MS));
  }
  term.focus();
}

function skipBoot() {
  endBoot();
}

// Buduje jeden wiersz logu. Wiersz "ready" nie ma znacznika OK - to podsumowanie.
function bootLine(key, isReady) {
  const li = document.createElement('li');
  li.className = isReady ? 'boot__line boot__line--ready' : 'boot__line';
  const name = document.createElement('span');
  name.textContent = t(key);
  li.appendChild(name);
  if (!isReady) {
    const ok = document.createElement('span');
    ok.className = 'boot__line-ok';
    ok.textContent = t('boot.line.ok');
    li.appendChild(ok);
  }
  return li;
}

function runBootSequence() {
  bootLogEl.replaceChildren();
  // Jeden zapis do DOM; kaskade robi animation-delay, nie lancuch setTimeoutow.
  BOOT_LINE_KEYS.forEach((key, i) => {
    const li = bootLine(key, false);
    li.style.animationDelay = `${BOOT_FIRST_LINE_MS + i * BOOT_LINE_STEP_MS}ms`;
    bootLogEl.appendChild(li);
  });
  const ready = bootLine('boot.line.ready', true);
  ready.style.animationDelay =
    `${BOOT_FIRST_LINE_MS + BOOT_LINE_KEYS.length * BOOT_LINE_STEP_MS}ms`;
  bootLogEl.appendChild(ready);

  document.addEventListener('keydown', skipBoot, true);
  bootEl.addEventListener('click', skipBoot);
  bootTimers.push(setTimeout(endBoot, BOOT_HOLD_MS));
}

// Etykieta przelacznika (osobno, bo musi przezyc zmiane jezyka).
function renderBootPref(enabled) {
  bootToggle.checked = enabled;
  bootStatus.textContent = t(enabled ? 'boot.on' : 'boot.off');
}

// Wywolywane raz z initAppearance(), juz PO ustawieniu jezyka i motywu: log
// jest wtedy w dobrym jezyku, a kolory od razu z wybranego motywu, wiec nic nie
// przeskakuje w trakcie animacji. Systemowe "ogranicz ruch" pomija ja calkiem.
function startBoot(enabled) {
  renderBootPref(enabled);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!enabled || reducedMotion) {
    endBoot(true);
    return;
  }
  runBootSequence();
}

bootToggle.addEventListener('change', () => {
  renderBootPref(bootToggle.checked);
  // Zmiana dziala od nastepnego uruchomienia - biezacej animacji nie cofamy.
  window.lunacore.setUiPrefs({ boot: bootToggle.checked });
});

// ---- Wyglad: motyw (theming) + jezyk (i18n) ---------------------------------
//
// Motywy pochodza z config/themes.json (mapy tokenow CSS + kolory xterm), jezyk
// ze slownika i18n.js. Wybor jest trwaly w config/ui.local.json. Przelaczenie
// dziala na zywo: tokeny leca na documentElement, palety xterm przez term.options,
// a napisy przez applyStatic() + ponowne wyrenderowanie dynamicznych.

const themeSwitcher = document.getElementById('theme-switcher');
const langSwitcher = document.getElementById('lang-switcher');
let themesById = new Map();

// Naklada tokeny motywu na :root oraz palete terminala.
function applyThemeVars(theme) {
  if (!theme) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars || {})) root.style.setProperty(k, v);
  if (theme.terminal && typeof theme.terminal === 'object') {
    applyTerminalTheme(theme.terminal);
  }
}

// Zmienia jezyk: statyczne etykiety + wszystkie dynamiczne trzymane w stanie.
function applyLang(lang) {
  window.i18n.setLang(lang);
  window.i18n.applyStatic();
  renderLed();
  renderPtyStatus();
  renderCtxText();
  renderBurn();
  renderUsage();
  renderAutoCompact();
  renderBootPref(bootToggle.checked);
  paletteItems = null; // odbuduje z nowymi tlumaczeniami przy nastepnym otwarciu
}

async function initAppearance() {
  let prefs = { theme: 'cyberpunk', lang: 'pl', boot: true };
  try {
    prefs = (await window.lunacore.getUiPrefs()) || prefs;
  } catch {
    /* brak preferencji - zostajemy przy domyslnych */
  }

  // Jezyk najpierw, zeby applyStatic zlapal caly DOM przy starcie.
  applyLang(prefs.lang);
  langSwitcher.value = prefs.lang;

  // Motywy: wypelnij liste i nalozony aktywny (lub pierwszy dostepny).
  try {
    const { themes } = await window.lunacore.getThemes();
    themesById = new Map((themes || []).map((th) => [th.id, th]));
    themeSwitcher.innerHTML = '';
    for (const th of themes || []) {
      const opt = document.createElement('option');
      opt.value = th.id;
      opt.textContent = th.label;
      themeSwitcher.appendChild(opt);
    }
    const active = themesById.has(prefs.theme)
      ? prefs.theme
      : themes && themes[0] && themes[0].id;
    if (active) {
      themeSwitcher.value = active;
      applyThemeVars(themesById.get(active));
    }
  } catch {
    /* brak motywow - zostaje wbudowany styl z styles.css */
  }

  // Na koncu, bo sekwencja ma juz znac jezyk i kolory wybranego motywu.
  startBoot(prefs.boot !== false);
}

themeSwitcher.addEventListener('change', () => {
  applyThemeVars(themesById.get(themeSwitcher.value));
  window.lunacore.setUiPrefs({ theme: themeSwitcher.value });
});

langSwitcher.addEventListener('change', () => {
  applyLang(langSwitcher.value);
  window.lunacore.setUiPrefs({ lang: langSwitcher.value });
});

initAppearance();

// ---- Wskaznik statusu PTY ----------------------------------------------------

// Stan trzymany semantycznie (klucz i18n), by zmiana jezyka go odswiezyla.
let ptyStatusState = { live: true, key: 'ptystatus.connecting', params: {} };

function setPtyStatus(isLive, key, params = {}) {
  ptyStatusState = { live: isLive, key, params };
  renderPtyStatus();
}

function renderPtyStatus() {
  const dot = document.getElementById('pty-status-dot');
  const label = document.getElementById('pty-status-text');
  dot.classList.toggle('dot--live', ptyStatusState.live);
  dot.classList.toggle('dot--dead', !ptyStatusState.live);
  label.textContent = t(ptyStatusState.key, ptyStatusState.params);
}

// ---- Zdarzenia okna ---------------------------------------------------------

window.addEventListener('resize', fitAndResize);

window.addEventListener('DOMContentLoaded', () => {
  fitAndResize();
});

// Pierwsze pobranie listy zakladek. Proces glowny rozglasza ja przy tworzeniu
// sesji - czyli zanim ten renderer zdazy sie podpiac - wiec stan poczatkowy
// musimy sobie odebrac sami, inaczej pasek zakladek zostalby pusty do pierwszej
// zmiany.
window.lunacore
  .getSessions()
  .then(({ sessions, activeSessionId: activeId }) => {
    sessionList = sessions || [];
    for (const meta of sessionList) ensureTerm(meta.id).alive = meta.alive;
    if (activeId) {
      activeSessionId = activeId;
      for (const [id, s] of termsBySession) s.el.classList.toggle('is-active', id === activeId);
      syncSwitchers();
    }
    renderTabs();
    fitAndResize();
    setPtyStatus(true, 'ptystatus.active');
    term.focus();
  })
  .catch(() => {
    // Nie udalo sie pobrac sesji - nie blokujemy startu HUD.
  });
