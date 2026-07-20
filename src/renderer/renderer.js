// ============================================================================
// LunaCore - renderer (frontend)
// ----------------------------------------------------------------------------
// * Renderuje terminal xterm.js i spina go z PTY przez most window.lunacore.
// * Obsluguje fizyczny przycisk COMPACT CONTEXT (Action Injector).
//
// Dostep do procesu glownego wylacznie przez `window.lunacore` (patrz preload.js).
// Globale `Terminal` i `FitAddon` pochodza z bibliotek xterm zaladowanych w HTML.
// ============================================================================

'use strict';

// ---- Inicjalizacja terminala ------------------------------------------------

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 5000,
  // Paleta dopasowana do motywu LunaCore (mroczny fiolet + neon).
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
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));

// Dopasuj terminal do kontenera i zsynchronizuj rozmiar PTY.
function fitAndResize() {
  try {
    fitAddon.fit();
    window.lunacore.resize(term.cols, term.rows);
  } catch (err) {
    // Ignoruj bledy dopasowania, gdy okno jest chwilowo o zerowym rozmiarze.
  }
}

// ---- Spiecie z PTY ----------------------------------------------------------

// PASSIVE OBSERVER: dane z procesu Claude CLI -> ekran terminala.
window.lunacore.onData((data) => {
  term.write(data);
  markWorking(); // LED: strumien plynie = Claude pracuje
});

// ACTION INJECTOR: kazde nacisniecie klawisza -> stdin PTY.
term.onData((data) => {
  window.lunacore.write(data);
});

// Status polaczenia PTY.
window.lunacore.onExit((code) => {
  setLedDead();
  setPtyStatus(false, `PTY: zakonczono (kod ${code})`);
  term.write(`\r\n\x1b[38;5;203m[LunaCore] Sesja PTY zakonczona (kod ${code}).\x1b[0m\r\n`);
});

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

function setLed(state, text) {
  led.className = `led led--${state}`;
  ledLabel.textContent = text;
}

// Wywolywane przy kazdej porcji stdout; timer przesuwa sie do przodu.
function markWorking() {
  if (ledDead) return;
  setLed('working', 'pracuje...');
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => setLed('waiting', 'czeka na Ciebie'), LED_IDLE_MS);
}

function setLedDead() {
  ledDead = true;
  clearTimeout(ledTimer);
  setLed('dead', 'sesja zakonczona');
}

// ---- Faza 3: Context Window (transcript JSONL) ------------------------------

const ctxFill = document.getElementById('ctx-fill');
const ctxPercent = document.getElementById('ctx-percent');
const ctxWarn = document.getElementById('ctx-warn');
const ctxTokens = document.getElementById('ctx-tokens');

// Progi kolorow paska: < 60% zielony, 60-85% zolty, > 85% czerwony + alarm.
const CTX_WARN_HIGH = 0.85;
const CTX_WARN_MID = 0.6;

window.lunacore.onContext((metrics) => {
  if (!metrics || typeof metrics.percent !== 'number') return;
  const pct = Math.max(0, Math.min(1, metrics.percent));

  // Pasek: scaleX 0..1 (bez layout thrash) + kolor zalezny od progu.
  ctxFill.style.setProperty('--ctx', pct.toFixed(3));
  ctxFill.classList.toggle('is-mid', pct >= CTX_WARN_MID && pct < CTX_WARN_HIGH);
  ctxFill.classList.toggle('is-high', pct >= CTX_WARN_HIGH);

  ctxPercent.textContent = `${Math.round(pct * 100)}%`;
  ctxWarn.textContent = pct >= CTX_WARN_HIGH ? 'Compact this shit!' : '';

  const k = (n) => `${Math.round(n / 1000)}k`;
  ctxTokens.textContent = `${k(metrics.tokens)} / ${k(metrics.limit)} tokenow`;
});

// ---- Faza 3: Skill Tracker (nazwy narzedzi ze stdout) -----------------------

// Kafelek zapala sie po wykryciu narzedzia i gasnie po chwili bezczynnosci.
const TILE_ACTIVE_MS = 1500;
const tileTimers = new Map();

window.lunacore.onTools((tiles) => {
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
});

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

// Zmiana profilu -> restart sesji PTY z nowym srodowiskiem.
profileSwitcher.addEventListener('change', () => {
  window.lunacore.switchProfile(profileSwitcher.value);
});

// Po restarcie: wyczysc terminal i pokaz, ktory profil jest aktywny.
window.lunacore.onRestarted((profile) => {
  ledDead = false; // nowa sesja - LED znowu zyje
  setLed('waiting', 'czeka na Ciebie');
  term.reset();
  term.write(
    `\x1b[38;5;80m[LunaCore] Sesja przelaczona na profil: ${profile.label}\x1b[0m\r\n`
  );
  setPtyStatus(true, 'PTY: aktywne');
  fitAndResize();
  term.focus();
});

initProfiles();

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
    portsEmpty.textContent = 'Brak nasluchujacych portow.';
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
    actions.appendChild(portButton('↗', 'open', 'Otworz w przegladarce', { port: p.port }));
    actions.appendChild(portButton('⧉', 'copy', 'Kopiuj URL', { port: p.port }));
    actions.appendChild(
      portButton('✕', 'kill', 'Zabij proces', { pid: p.procId, name: p.name, port: p.port })
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
    if (!confirm(`Zabic proces ${name} (PID ${pid}) na porcie ${port}?`)) return;
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
    padStatus.textContent = ok ? 'zapisano' : 'blad zapisu';
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

// ---- Wskaznik statusu PTY ----------------------------------------------------

function setPtyStatus(isLive, text) {
  const dot = document.getElementById('pty-status-dot');
  const label = document.getElementById('pty-status-text');
  dot.classList.toggle('dot--live', isLive);
  dot.classList.toggle('dot--dead', !isLive);
  label.textContent = text;
}

// ---- Zdarzenia okna ---------------------------------------------------------

window.addEventListener('resize', fitAndResize);

window.addEventListener('DOMContentLoaded', () => {
  fitAndResize();
});

// Pierwsze dopasowanie po pelnym ulozeniu layoutu + oznaczenie sesji jako aktywnej.
requestAnimationFrame(() => {
  fitAndResize();
  setPtyStatus(true, 'PTY: aktywne');
  term.focus();
});
