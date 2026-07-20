# MASTER PROMPT: Budowa aplikacji LunaCore (Wizualny GUI Wrapper dla Claude CLI)

## STATUS (punkt startu następnej sesji)

> ✅ **FAZA 1, 2, 3 i 4 — ZROBIONE** (2026-07-19).
> Działa: okno Electron, interaktywny terminal `claude` na PTY, bezpieczny IPC,
> przycisk **⚡ COMPACT CONTEXT**, **Passive Observer** (pasek Context Window z
> realnych tokenów + kafelki Skill Tracker), oraz **profile uruchomieniowe**
> (przełącznik w lewym panelu → restart sesji z env z `config/profiles.json`).
> Kod: `src/observer.js`, `src/profiles.js` + wpięcia w `main.js`/`preload.js`/`renderer/`.
>
> ✅ **7A, 7B i 7C — ZROBIONE** (2026-07-19). Cały backlog domknięty. 7A:
> `src/skills.js` (auto-skan `~/.claude/skills` + `plugins`, frontmatter SKILL.md,
> kategoryzacja heurystyczna, ~339 skilli, cache) + sekcja zwijek w lewym panelu.
> 7B: `src/ports.js` + porty. 7C: `src/cheatsheets.js` + przyciski komend.
>
> ✅ **BIBLIOTEKA PROMPTÓW — ZROBIONE** (2026-07-20). `src/prompts.js` +
> `config/prompts.json` (+ gitignorowany `.local.json`) + sekcja „Prompty" w lewym
> panelu. Wielolinijkowe prompty wklejane przez **bracketed paste** (`ESC[200~ …
> ESC[201~`, kanał IPC `pty:paste`) — surowy zapis wysłałby prompt po pierwszej
> linii i rozbił go na kilka wiadomości. Główny przycisk wkleja BEZ wysłania,
> przycisk `⏎` wkleja i wysyła.
>
> 👉 **NASTĘPNY KROK:** kolejne pozycje z shortlisty `FUTURE_PLAN.md` §5.5 —
> najbliższa to **command palette (Ctrl+K)** (fuzzy search po wszystkich akcjach:
> przyciski, ściągi, skille, prompty), dalej **armed auto-compact**, **sparkline
> burn-rate**, **LED working-vs-waiting**, **przełącznik CWD/projektu**,
> **scratchpad**. Do decyzji: multi-terminal workspace (multi-PTY tabs).

---

## ROLA I CEL

Jesteś wybitnym inżynierem oprogramowania specjalizującym się w aplikacjach
desktopowych (Electron/Tauri), emulatorach terminali oraz integracji z procesami
systemowymi (node-pty).

Twoim celem jest rozwijanie lokalnej aplikacji desktopowej **LunaCore** — wizualnej
nakładki (dashboard) na oficjalne narzędzie Claude Code CLI.

---

## 1. INSPIRACJA I KONTEKST

* **Główna inspiracja:** projekt szablonów i agentów
  [claude-code-templates](https://github.com/davila7/claude-code-templates).
  Chcemy „centrum dowodzenia" dla bogatego zestawu skilli, MCP i agentów.
* **Obecny stan:** użytkownik posiada zaawansowany CLI dashboard w terminalu
  (Context Window w %, czas operacji, aktywne serwery MCP, estymowany koszt).
* **Problem do rozwiązania:** brak interaktywnego sterowania (klikalne przyciski
  zamiast wpisywania komend) oraz potrzeba lepszej wizualizacji, które z ~300
  skilli są w danej chwili używane przez model.

---

## 2. KLUCZOWE ZAŁOŻENIE I OGRANICZENIE (MUST-HAVE)

> ⚠️ **STRICT CONSTRAINT: ZERO DODATKOWYCH TOKENÓW**
> Aplikacja **NIE MOŻE** wstrzykiwać do Claude żadnych ukrytych promptów,
> middleware ani modyfikować binarki `claude`. Każda „inteligentna" analiza
> kontekstu przez dodatkowego agenta spali context window użytkownika.
>
> **Jak to ma działać:**
> * **Passive Observer** — nasłuchuje `stdout` procesu CLI i wyciąga dane Regexami
>   na poziomie backendu Node.js.
> * **Action Injector** — fizyczne przyciski GUI symulują wpisanie tekstu przez
>   użytkownika bezpośrednio do `stdin` działającego procesu terminala.

---

## 3. STOS TECHNOLOGICZNY (TECH STACK)

* **Środowisko:** Electron (33.x) z bezpiecznymi ustawieniami — `contextIsolation`
  włączone, `nodeIntegration` wyłączone, most IPC przez `preload.js`
  (`contextBridge` → `window.lunacore`). Renderer NIE ma bezpośredniego dostępu do
  Node.js.
* **Terminal Core:** **`@lydell/node-pty`** (prebuilt N-API — działa bez node-gyp /
  Visual Studio Build Tools; oryginalny `node-pty` nie kompiluje się, bo node-gyp
  nie wykrywa VS Build Tools 2026 na tej maszynie) + `@xterm/xterm` z pluginem
  `@xterm/addon-fit`.
* **Frontend:** Vanilla HTML/CSS/JS, styl mrocznego cyberpunkowego dashboardu
  LunaCore (neonowy fiolet + cyan).

---

## 4. ARCHITEKTURA INTERFEJSU (LAYOUT)

Aplikacja podzielona na 3 sekcje:

1. **Lewy Panel (Kontrola i Akcje):**
   * Przycisk `[⚡ COMPACT CONTEXT]` — kliknięcie wysyła `/compact\r` do PTY. ✅
   * Przełącznik Profili / Środowisk (Claude Cloud vs lokalne LM Studio) — Faza 4.
2. **Centrum (Główny Terminal):**
   * Wyrenderowane okno `xterm.js` z interaktywną sesją Claude CLI. ✅
3. **Prawy Panel (Monitor Statusu):**
   * **Skill Tracker:** kafelki skilli / MCP; kafelek zapala się na zielono, gdy
     regex wykryje `Running tool: [nazwa]`. (layout gotowy, logika = Faza 3)
   * **Wskaźnik Context Window:** pasek postępu zmieniający kolor (Zielony < 60%,
     Żółty 60–85%, Czerwony > 85% z ostrzeżeniem „Compact this shit!").
     (layout gotowy, logika = Faza 3)

---

## 5. CO JUŻ ZROBIONE (Faza 1 + 2)

* Konfiguracja projektu Electron, spięcie main ↔ renderer przez preload.
* `@lydell/node-pty` uruchamia powłokę (`powershell.exe` na Win) + auto-`claude`
  (flaga `AUTO_LAUNCH_CLAUDE` w `src/main.js`).
* Osadzony i ostylowany `xterm.js` + `addon-fit` (płynny, interaktywny terminal).
* Kanały IPC: `pty:data` (observer), `pty:write` (klawiatura), `pty:command`
  (przyciski), `pty:resize`.
* Działający przycisk **⚡ COMPACT CONTEXT** → `runCommand('/compact')`.
* Prawy panel (pasek Context Window + kafelki Skill Trackera) obecny w layoucie
  jako placeholdery, gotowy pod podpięcie parsera.

---

## 6. FAZY DALSZE (ROADMAP)

### FAZA 3: Parser Strumienia i Metryki (Passive Observer) — ✅ ZROBIONE
* `src/observer.js`: `detectTools()` (strip ANSI + regex nazw narzędzi) oraz
  `TranscriptWatcher` (tailowanie `~/.claude/projects/**/*.jsonl`, realne tokeny
  z pola `message.usage`).
* Kanały IPC: `metrics:tools` (kafelki Skill Tracker), `metrics:context`
  (`{tokens, limit, percent}` → pasek + kolory progów + alarm > 85%).
* Uwaga: `CONTEXT_LIMIT` w `observer.js` = 200k (default). Dla okna 1M podbij ręcznie.

### FAZA 4: Zarządzanie Profilami (LM Studio / Codex) — ✅ ZROBIONE
* `config/profiles.json` (+ opcjonalny `config/profiles.local.json`, gitignore):
  profile `{id,label,command,args,env}`. `src/profiles.js` ładuje/waliduje/scalają.
* Przełącznik w lewym panelu → IPC `pty:restart` → `restartPty()` ubija sesję i
  startuje nową z nadpisaniami env (np. `ANTHROPIC_BASE_URL` dla LM Studio).
* Profile domyślne: Claude Cloud / LM Studio (lokalnie) / Sama powłoka.

---

## 7. PLANY / POMYSŁY DO ZAPROJEKTOWANIA (backlog)

Wzorzec wizualny dla wszystkich „ściągawek" poniżej:
`file:///C:/Users/Kotsur69/.claude/helpers/ecc-sciagawka-mati.html`
— zwijane sekcje (`<details>`/`<summary>`), badge'y (cmd / skill / hook), czytelne
kroki. Chcemy ten sam feel wbudowany natywnie w prawym/dolnym panelu LunaCore.

### 7A. Zwijana ściągawka skilli (Skill Cheat-Sheet) — ✅ ZROBIONE
* `src/skills.js`: auto-skan `~/.claude/skills` + `~/.claude/plugins` (rekursywnie,
  SKILL.md → frontmatter name/description), dedupe, kategoryzacja heurystyczna
  (Frontend/Backend/Data-ML/DevOps/Testy/Security/Database/Git/Docs/Inne), cache.
* Lewy panel: zwijki per kategoria; klik skilla = kopiuj nazwę. ~339 skilli.
* UWAGA: kategoryzacja słowami-kluczami jest zgrubna (świadomy wybór auto-skanu).

### 7B. Tracker otwartych portów localhost — ✅ ZROBIONE
* `src/ports.js`: `scanPorts()` (`Get-NetTCPConnection` na Win / `lsof` na POSIX),
  `PortWatcher` (polling 4s, emisja tylko przy zmianie), `killProcess()` (taskkill).
* Prawy panel: lista port · proces · PID + akcje otwórz/kopiuj/kill (z confirm).
* IPC: `ports:update`, `ports:open` (shell.openExternal), `ports:kill`. Read-only.

### 7C. Ściągawki akcji ze „zwijką + przyciskami komend" — ✅ ZROBIONE
* `config/cheatsheets.json` (+ `cheatsheets.local.json`) → `src/cheatsheets.js`
  (load/walidacja/merge). Renderer buduje `<details>` z rzędem przycisków; klik =
  `runCommand()` przez Action Injector (kanał `pty:command`).
* Konwencja: `!cmd` = powłoka (bash) w sesji Claude; `cmd` bez prefiksu = wprost.
* Grupy domyślne: Review przed commitem, Git, Sesja Claude, Testy/Build.

---

### 7D. Biblioteka promptów (wielolinijkowych) — ✅ ZROBIONE

* `config/prompts.json` (+ `prompts.local.json`, gitignore) → `src/prompts.js`
  (load/walidacja/merge po `title`). Pole `text` = string albo tablica linii.
* Lewy panel, sekcja „Prompty": zwijki per grupa, w środku wiersze
  `[etykieta][⏎]`. Główny przycisk **wkleja bez wysyłania** (można dopisać
  szczegóły), `⏎` wkleja i wysyła.
* Kanał IPC `pty:paste` → **bracketed paste** `ESC[200~ … ESC[201~` + normalizacja
  `\r\n` → `\n`. Powód: w TUI Claude każdy newline to Enter, więc surowy write
  wysłałby prompt po pierwszej linii.

---

## ZADANIE DLA CIEBIE — następny krok

**Fazy 1–4, backlog 7A/7B/7C oraz biblioteka promptów (7D) są gotowe** (patrz
STATUS + `README.md` + `src/`). LunaCore ma: terminal PTY, COMPACT, Passive
Observer (context + Skill Tracker), profile, tracker portów, ściągi akcji,
ściągawkę skilli i bibliotekę promptów.

Dalszy kierunek = shortlista z `FUTURE_PLAN.md` §5.5, w kolejności (nie zaczynaj
bez potwierdzenia Matiego):
1. **Command palette (Ctrl+K)** — fuzzy search po wszystkich akcjach naraz
   (przyciski, ściągi, skille, prompty), obsługa z klawiatury.
2. **Armed auto-compact** — przełącznik armed/off; po przekroczeniu progu sam
   wstrzykuje `/compact` (domyślnie WYŁĄCZONY, świadomy koszt tokenów).
3. **Sparkline burn-rate** — wykres zużycia kontekstu w czasie.
4. **LED working-vs-waiting** — status „Claude myśli" vs „czeka na input".
5. **Przełącznik CWD / projektu** — start `claude` w wybranym repo. Projektować
   tak, by nie blokował późniejszych multi-PTY tabs (decyzja Matiego odłożona).
6. **Scratchpad** — notatki per projekt, `config/scratchpad.local.json`.

Poza shortlistą, wciąż otwarte: wskaźnik **% sesji / limitów tygodniowych**
(pomysł Matiego — dziś sprawdzany ręcznie na drugim monitorze), persystencja
aktywnego profilu, filtr portów systemowych, electron-builder (Faza 5).

Pisz kod czysty, skomentowany, gotowy do uruchomienia lokalnie. Let's continue LunaCore!
