// ============================================================================
// LunaCore - Licznik zuzycia limitow subskrypcji (usage meter)
// ----------------------------------------------------------------------------
// Pobiera wykorzystanie okien limitu (5h + 7 dni) z prywatnego endpointu OAuth,
// tego samego, z ktorego korzysta `claude` przy `/status`:
//   GET https://api.anthropic.com/api/oauth/usage
//
// ZERO TOKENOW CLAUDE: to zwykly odczyt (GET), NIE wywolanie modelu (/v1/messages
// nie jest dotykane). Nie zjada ani sesji, ani limitu tygodniowego.
//
// AUTORYZACJA BEZ WLASNEGO REFRESHU: token czytamy ZA KAZDYM RAZEM na swiezo z
// ~/.claude/.credentials.json. To sam `claude` CLI odswieza i nadpisuje ten plik,
// wiec "jedziemy na jego refreshu" - nie implementujemy wlasnego OAuth. Gdy token
// wygasl i nie ma jak go odswiezyc (CLI nie chodzi) -> 401 -> stan 'reauth'.
//
// UWAGA: endpoint jest nieudokumentowany/prywatny. Kod degraduje sie lagodnie
// (stany 'reauth' / 'unavailable') zamiast pokazywac zmyslona liczbe.
// ============================================================================

'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_HOST = 'api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';

/** Czyta swiezy accessToken z pliku poswiadczen CLI. null = brak/zly plik. */
function readToken() {
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const oauth = cred && cred.claudeAiOauth;
    if (oauth && typeof oauth.accessToken === 'string' && oauth.accessToken) {
      return oauth.accessToken;
    }
  } catch {
    /* brak pliku / niepoprawny JSON - traktujemy jak brak autoryzacji */
  }
  return null;
}

/** GET JSON z naglowkami OAuth Claude Code. Resolve zawsze ({status, body}). */
function httpsGetJson(host, pathname, token) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: 'GET',
        host,
        path: pathname,
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'User-Agent': 'LunaCore/0.1 (usage-meter)',
          Accept: 'application/json',
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.end();
  });
}

/** Normalizuje jedno okno limitu ({utilization, resets_at}) -> {pct, resetsAt}. */
function pickWindow(w) {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    pct: Math.max(0, Math.min(100, Math.round(w.utilization))),
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

/**
 * Jednorazowy odczyt zuzycia. Zwraca albo znormalizowany stan, albo {error}:
 *   'reauth'      - brak/wygasly token (401/403 lub brak pliku)
 *   'unavailable' - siec/timeout/zmiana endpointu (inny status, zly JSON)
 */
async function fetchUsage() {
  const token = readToken();
  if (!token) return { error: 'reauth' };

  const { status, body } = await httpsGetJson(USAGE_HOST, USAGE_PATH, token);
  if (status === 401 || status === 403) return { error: 'reauth' };
  if (status !== 200) return { error: 'unavailable' };

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'unavailable' };
  }

  return {
    fiveHour: pickWindow(data.five_hour),
    sevenDay: pickWindow(data.seven_day),
    sevenDayOpus: pickWindow(data.seven_day_opus),
    sevenDaySonnet: pickWindow(data.seven_day_sonnet),
    extraUsage: !!(data.extra_usage && data.extra_usage.is_enabled),
    fetchedAt: Date.now(),
  };
}

/**
 * Cyklicznie pobiera zuzycie i emituje, gdy sie zmieni (jak PortWatcher).
 * Odliczanie do resetu liczy renderer z resetsAt, wiec porownujemy stan BEZ
 * pol pochodnych (fetchedAt) - inaczej emitowaloby co tick bez realnej zmiany.
 */
class UsageWatcher {
  /** @param {(usage: object) => void} onUpdate */
  constructor(onUpdate, intervalMs = 90000) {
    this.onUpdate = onUpdate;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastJson = '';
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick(); // pierwszy odczyt od razu
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return; // nie nakladaj zapytan
    this.busy = true;
    try {
      const usage = await fetchUsage();
      const cmp = JSON.stringify({ ...usage, fetchedAt: 0 });
      if (cmp !== this.lastJson) {
        this.lastJson = cmp;
        this.onUpdate(usage);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Wymusza natychmiastowy odczyt + emisje (przycisk odswiezania w UI). */
  refresh() {
    this.lastJson = ''; // wymus emisje przy nastepnym odczycie
    return this.tick();
  }
}

module.exports = { fetchUsage, UsageWatcher };
