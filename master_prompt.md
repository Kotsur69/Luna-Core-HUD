\# MASTER PROMPT: Budowa aplikacji LunaCore (Wizualny GUI Wrapper dla Claude CLI)



\## ROLA I CEL

Jesteś wybitnym inżynierem oprogramowania specjalizującym się w aplikacjach desktopowych (Electron/Tauri), emulatorach terminali oraz integracji z procesami systemowymi (node-pty). 

Twoim celem jest zaprojektowanie i napisanie lokalnej aplikacji desktopowej o nazwie \*\*LunaCore\*\*. Będzie to wizualna nakładka (dashboard) na oficjalne narzędzie Claude Code CLI.



\---



\## 1. INSPIRACJA I KONTEKST

\* \*\*Główna inspiracja:\*\* Projekt szablonów i agentów \[https://github.com/davila7/claude-code-templates](https://github.com/davila7/claude-code-templates). Chcemy stworzyć "centrum dowodzenia" dla bogatego zestawu skilli, mcp i agentów.

\* \*\*Obecny stan:\*\* Użytkownik posiada już zaawansowany CLI dashboard w terminalu wyświetlający metryki: użycie Context Window w %, czas operacji, aktywne serwery MCP oraz estymowany koszt.

\* \*\*Problem do rozwiązania:\*\* Brak możliwości interaktywnego sterowania (np. kliknięcia fizycznego przycisku zamiast wpisywania komend z palca) oraz potrzeba lepszej wizualizacji, które z \~300 skilli są w danej chwili używane przez model.



\---



\## 2. KLUCZOWE ZAŁOŻENIE I OGRANICZENIE (MUST-HAVE)

> ⚠️ \*\*STRICT CONSTRAINT: ZERO DODATKOWYCH TOKENÓW\*\*

> Aplikacja \*\*NIE MOŻE\*\* wstrzykiwać do Claude żadnych ukrytych promptów systemowych, middleware ani modyfikować binarnego pliku `claude`. Każda próba "inteligentnej" analizy kontekstu przez dodatkowego agenta spali context window użytkownika.

>

> \*\*Jak to ma działać:\*\*

> Aplikacja działa wyłącznie jako \*\*Passive Observer\*\* (nasłuchuje strumienia `stdout` procesu CLI i wyciąga z niego dane za pomocą Regexów na poziomie backendu Node.js) oraz \*\*Action Injector\*\* (fizyczne przyciski na GUI symulują wpisanie tekstu przez użytkownika bezpośrednio do strumienia `stdin` działającego procesu terminala).



\---



\## 3. STOS TECHNOLOGICZNY (TECH STACK)

\* \*\*Środowisko:\*\* Electron (lub Tauri) – do wyboru stabilne i łatwe w konfiguracji środowisko z dostępem do Node.js API.

\* \*\*Terminal Core:\*\* `node-pty` (do wielowątkowego zarządzania procesem Claude CLI jako pseudoterminal) + `xterm.js` wraz z pluginem `xterm-addon-fit` (do renderowania pięknego terminala w oknie aplikacji).

\* \*\*Frontend:\*\* HTML, CSS, JavaScript (Vanilla, React lub Svelte) stylizowany na mroczny, cyberpunkowy dashboard dopasowany do motywu LunaCore.



\---



\## 4. ARCHITEKTURA INTERFEJSU (LAYOUT)

Aplikacja ma być podzielona na 3 sekcje:

1\. \*\*Lewy Panel (Kontrola i Akcje):\*\*

&#x20;  \* Przycisk `\[⚡ COMPACT CONTEXT]` – jego kliknięcie natychmiast wysyła `/compact\\n` do procesu PTY.

&#x20;  \* Przełącznik Profili / Środowisk (np. Claude Cloud vs Lokalne LM Studio).

2\. \*\*Centrum (Główny Terminal):\*\*

&#x20;  \* Wyrenderowane okno `xterm.js`, w którym normalnie toczy się rozmowa z Claude CLI.

3\. \*\*Prawy Panel (Monitor Statusu):\*\*

&#x20;  \* \*\*Skill Tracker:\*\* Lista kafelków reprezentujących najważniejsze skille / serwery MCP. Na podstawie przechwyconych logów stdout (np. gdy regex wykryje `Running tool: \[nazwa]`), odpowiedni kafelek podświetla się na zielono.

&#x20;  \* \*\*Wskaźnik Context Window:\*\* Wizualny pasek postępu (Progress Bar) zmieniający kolor w zależności od zużycia (Zielony < 60%, Żółty 60-85%, Czerwony > 85% z ostrzeżeniem "Compact this shit!").



\---



\## 5. FAZY WDROŻENIA PROJEKTU



Zbudujemy ten projekt krok po kroku. Na tym etapie skupmy się na przygotowaniu architektury i pierwszych plików konfiguracyjnych.



\### FAZA 1: Inicjalizacja i uruchomienie PTY

\* Konfiguracja projektu Electron.

\* Spięcie procesu głównego (`main.js`) z procesem renderowania.

\* Implementacja `node-pty` uruchamiającego domyślną powłokę z komendą `claude`.

\* Osadzenie i stylizacja `xterm.js` w oknie głównym, aby terminal działał płynnie i interaktywnie.



\### FAZA 2: Kanał Akcji (Action Injector)

\* Implementacja mechanizmu IPC (Inter-Process Communication) w Electronie.

\* Stworzenie przycisku na froncie `\[Compact Context]`.

\* Zaprogramowanie backendu tak, aby po kliknięciu przycisku pisał bezpośrednio do aktywnego strumienia: `ptyProcess.write('/compact\\r')`.



\### FAZA 3: Parser Strumienia i Metryki (Passive Observer)

\* Dodanie listenera na dane wyjściowe z PTY (`ptyProcess.onData(...)`).

\* Stworzenie parsera Regex, który wyciąga z logów informacje o zużyciu tokenów/kontekstu, aktywnych narzędziach MCP oraz statusie (np. "manual mode on").

\* Przesyłanie sparsowanych metryk w czasie rzeczywistym do frontendu w celu aktualizacji widgetów bocznych.



\### FAZA 4: Zarządzanie Profilami (LM Studio / Codex)

\* Dodanie możliwości definiowania profili uruchomieniowych w pliku JSON.

\* Opcja automatycznego restartu sesji PTY z flagami wskazującymi na lokalny endpoint LM Studio (`--api-url http://localhost:1234/v1`).



\---



\## ZADANIE DLA CIEBIE (KROK 1)

Zaczynamy od \*\*Fazy 1 i Fazy 2\*\*. Wygeneruj dla mnie:

1\. Strukturę katalogów dla projektu opartego na Electronie.

2\. Kompletny plik `package.json` z niezbędnymi zależnościami (`node-pty`, `xterm`, `xterm-addon-fit`, `electron`).

3\. Kod procesu głównego (`main.js`), który poprawnie konfiguruje pseudoterminal i obsługuje kanał IPC do wysyłania komend (takich jak `/compact`).

4\. Kod prostego frontendu (`index.html` + `renderer.js`), który wyświetla terminal `xterm.js` na środku oraz boczny panel z fizycznym, działającym przyciskiem `⚡ COMPACT CONTEXT`.



Pisz kod czysty, skomentowany, gotowy do uruchomienia lokalnie. Let's build LunaCore!

