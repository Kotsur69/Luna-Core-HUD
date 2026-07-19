# MASTER PROMPT: Budowa aplikacji LunaCore (Wizualny GUI Wrapper dla Claude CLI)

## STATUS (punkt startu następnej sesji)

> ✅ **FAZA 1, 2 i 3 — ZROBIONE** (2026-07-19).
> Działa: okno Electron, interaktywny terminal `claude` na PTY, bezpieczny IPC,
> przycisk **⚡ COMPACT CONTEXT**, oraz **Passive Observer** (Faza 3): pasek
> Context Window z realnych tokenów (tailowanie transcript JSONL) + kafelki Skill
> Tracker zapalane detekcją narzędzi ze stdout. Kod: `src/observer.js` + wpięcia
> w `src/main.js`, `src/preload.js`, `src/renderer/`.
>
> 👉 **NASTĘPNY KROK = FAZA 4** (profile LM Studio / Codex) — albo backlog z sekcji
> 7 (ściągawki: skille / porty / akcje-przyciski). Szczegóły w „ZADANIE DLA CIEBIE".

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

### FAZA 4: Zarządzanie Profilami (LM Studio / Codex) — NASTĘPNA
* Definiowanie profili uruchomieniowych w pliku JSON (`config/profiles.json`).
* Restart sesji PTY z flagami wskazującymi lokalny endpoint LM Studio
  (`--api-url http://localhost:1234/v1`).

---

## 7. PLANY / POMYSŁY DO ZAPROJEKTOWANIA (backlog)

Wzorzec wizualny dla wszystkich „ściągawek" poniżej:
`file:///C:/Users/Kotsur69/.claude/helpers/ecc-sciagawka-mati.html`
— zwijane sekcje (`<details>`/`<summary>`), badge'y (cmd / skill / hook), czytelne
kroki. Chcemy ten sam feel wbudowany natywnie w prawym/dolnym panelu LunaCore.

### 7A. Zwijana ściągawka skilli (Skill Cheat-Sheet)
* Zwijki wg kategorii: klikam **FRONTEND** → rozwija się lista skilli do frontendu;
  **BACKEND** → lista backendowych; itd. (Design, DevOps/Deploy, Testing, Git,
  Data/ML, Security, Docs...).
* Źródło listy: ~300 skilli (katalog skilli / plugin cache Claude Code).
* Cel: szybki podgląd „co mam pod ręką", bez scrollowania całej płaskiej listy.

### 7B. Tracker otwartych portów localhost
* Panel pokazujący nasłuchujące porty localhost na żywo (backend: `netstat -ano` /
  `Get-NetTCPConnection`, mapowanie PID → nazwa procesu), z auto-odświeżaniem.
* Akcje przy wpisie: otwórz `http://localhost:PORT`, kopiuj, opcjonalnie kill PID.
* W duchu Passive Observer — czysto lokalne, zero tokenów.

### 7C. Ściągawki akcji ze „zwijką + przyciskami komend" (NAJWAŻNIEJSZE)
* Zwijane sekcje tematyczne (à la ecc-sciagawka), a **pod każdą zwijką rząd
  przycisków**, które przez Action Injector wysyłają konkretne komendy do CLI.
* Przykład — zwijka **„Review przed commitem"**: checklista/ściąga na górze, a pod
  nią przyciski: `/code-review`, `/security-review`, `npm test`, `git diff`,
  `git status` itp. — każdy przycisk = jedno wstrzyknięcie komendy do stdin.
* Docelowo zestaw gotowych zwijek (Review, Git, Testy, Deploy...), każda z własnym
  zestawem przycisków-komend. To najwygodniejszy wariant sterowania.

---

## ZADANIE DLA CIEBIE (NASTĘPNY KROK = FAZA 4 lub backlog)

Nie zaczynamy od zera — **Fazy 1, 2 i 3 są gotowe** (patrz STATUS + `README.md` +
`src/observer.js`). Do wyboru następny krok:

**Opcja A — FAZA 4 (profile LM Studio / Codex):**
1. `config/profiles.json` z definicjami profili uruchomieniowych (nazwa, komenda,
   flagi, np. `--api-url http://localhost:1234/v1`).
2. Przełącznik profili w lewym panelu (dziś `disabled`) → restart sesji PTY z
   wybranym profilem. Nowy kanał IPC `pty:restart` + logika w `main.js`.

**Opcja B — backlog z sekcji 7** (ściągawki: skille wg kategorii / porty localhost /
akcje-przyciski). Najbardziej „user-facing" jest 7C (zwijki + przyciski komend).

Pisz kod czysty, skomentowany, gotowy do uruchomienia lokalnie. Let's continue LunaCore!
