// ============================================================================
// LunaCore - Mission Control IPC (main process)
// ----------------------------------------------------------------------------
// Wires the mission:* channels to the mail and calendar jobs, and the agenda
// to the Google Calendar API client (src/gcal.js - no model call). Lives outside
// main.js on purpose (main.js is far past the file-size guideline); main.js
// only calls registerMissionIpc() once.
//
// State held here, and why:
//   - lastPreview: the validated mail preview. mission:mail-apply only trashes
//     ids found in it (see missionmail.js approvedTrashIds) - the renderer can
//     tick and untick, but it cannot introduce a thread id of its own.
//   - busy: one job per kind at a time. A double-click must not start two
//     overlapping inbox scans, each costing a full model call.
// ============================================================================

'use strict';

const { runJob, MISSION_MODELS, DEFAULT_MISSION_MODEL } = require('./missionrunner');
const { loadMissionConfig } = require('./missionconfig');
const mail = require('./missionmail');
const cal = require('./missioncal');
const { createGcal } = require('./gcal');

const TIMEOUTS = { preview: 300000, apply: 180000, parse: 60000, create: 120000 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local ISO 8601 with the zone offset, e.g. 2026-10-08T14:03:00+02:00. */
function localIsoNow(date = new Date()) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
/** Create failures where the event may still exist in the calendar. */
const UNSURE_CREATE = new Set(['timeout', 'cli-error', 'bad-json']);

/** A GcalError keeps its reason; anything else is logged and made generic. */
function gcalFailure(err) {
  if (err && typeof err.reason === 'string') {
    console.error('[mission] google calendar:', err.reason, err.message);
    return { ok: false, reason: err.reason };
  }
  console.error('[mission] google calendar failed:', err && err.message);
  return { ok: false, reason: 'gcal-failed' };
}

/**
 * @param {{ipcMain:object, getModel:()=>string, getEnv:()=>Record<string,string>, run?:Function, gcal?:object}} deps
 *   `run` and `gcal` are injectable so tests can exercise the handlers
 *   without a CLI or the network.
 */
function registerMissionIpc({ ipcMain, getModel, getEnv, run = runJob, gcal = createGcal() }) {
  let lastPreview = null;
  const busy = new Set();

  const model = () => {
    const m = getModel();
    return MISSION_MODELS.includes(m) ? m : DEFAULT_MISSION_MODEL;
  };

  /** Runs `fn` under the per-kind busy guard; always resolves. */
  async function guarded(kind, fn) {
    if (busy.has(kind)) return { ok: false, reason: 'busy' };
    busy.add(kind);
    try {
      return await fn();
    } catch (err) {
      console.error(`[mission] ${kind} failed:`, err && err.message);
      return { ok: false, reason: 'generic' };
    } finally {
      busy.delete(kind);
    }
  }

  const job = (kind, prompt, opts) =>
    run({ prompt, model: model(), env: getEnv(), timeoutMs: TIMEOUTS[kind], ...opts });

  ipcMain.handle('mission:config', () => {
    const { calendar } = loadMissionConfig();
    return {
      model: model(),
      models: MISSION_MODELS,
      categories: calendar.categories,
      days: calendar.days,
      gcal: gcal.status(),
    };
  });

  ipcMain.handle('mission:mail-preview', () =>
    guarded('preview', async () => {
      const { mail: rules } = loadMissionConfig();
      const res = await job('preview', mail.buildMailPreviewPrompt(rules, localIsoNow()), {
        allowed: mail.PREVIEW_TOOLS,
      });
      if (!res.ok) return res;
      lastPreview = mail.parseMailPreview(res.answer);
      return { ok: true, preview: lastPreview, costUsd: res.costUsd };
    })
  );

  ipcMain.handle('mission:mail-apply', (_event, ids) =>
    guarded('apply', async () => {
      const approved = mail.approvedTrashIds(ids, lastPreview);
      if (approved.length === 0) return { ok: false, reason: 'nothing-approved' };
      const res = await job('apply', mail.buildMailApplyPrompt(approved), { allowed: mail.APPLY_TOOLS });
      if (!res.ok) return res;
      const result = mail.parseMailApply(res.answer, approved);
      // Trashed threads leave the preview, so a second Apply cannot re-send them.
      const gone = new Set(result.trashed);
      const keep = (r) => !gone.has(r.threadId);
      lastPreview = {
        ...lastPreview,
        trash: lastPreview.trash.filter(keep),
        needsCall: lastPreview.needsCall.filter(keep),
      };
      return { ok: true, ...result, costUsd: res.costUsd };
    })
  );

  // No argument: the next `days` days from now (the week list). `{month}`:
  // that whole calendar month (the month grid). Read from the Calendar API.
  ipcMain.handle('mission:cal-agenda', (_event, req) =>
    guarded('agenda', async () => {
      const { calendar } = loadMissionConfig();
      let from;
      let to;
      if (req && req.month !== undefined) {
        const bounds = cal.monthBounds(req.month);
        if (!bounds) return { ok: false, reason: 'bad-range' };
        ({ start: from, end: to } = bounds);
      } else {
        from = new Date();
        to = new Date(from.getTime() + calendar.days * DAY_MS);
      }
      try {
        const { events } = await gcal.listEvents({
          fromIso: localIsoNow(from),
          toIso: localIsoNow(to),
          categories: calendar.categories,
        });
        return { ok: true, events };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  // Opens the browser for Google consent and waits (up to 3 min) for the
  // loopback redirect. One at a time: a second click while waiting is `busy`.
  ipcMain.handle('mission:gcal-connect', () =>
    guarded('gcal-connect', async () => {
      try {
        await gcal.connect();
        return { ok: true, gcal: gcal.status() };
      } catch (err) {
        return gcalFailure(err);
      }
    })
  );

  ipcMain.handle('mission:cal-parse', (_event, text) =>
    guarded('parse', async () => {
      if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
      const { calendar } = loadMissionConfig();
      const prompt = cal.buildParsePrompt({
        text,
        nowIso: localIsoNow(),
        timeZone: timeZone(),
        categories: calendar.categories,
      });
      const res = await job('parse', prompt, { lean: true });
      if (!res.ok) return res;
      const parsed = cal.normalizeDraft(res.answer, calendar.categories);
      return parsed.ok ? { ...parsed, costUsd: res.costUsd } : parsed;
    })
  );

  ipcMain.handle('mission:cal-create', (_event, rawDraft) =>
    guarded('create', async () => {
      const { calendar } = loadMissionConfig();
      // Re-validated: the draft has been through the renderer since PARSE.
      const checked = cal.normalizeDraft(rawDraft, calendar.categories);
      if (!checked.ok) return checked;
      const prompt = cal.buildCreatePrompt(checked.draft, calendar.categories, timeZone());
      const res = await job('create', prompt, { allowed: cal.CREATE_TOOLS });
      // A timeout or CLI error can land AFTER create_event went through; a
      // plain error would invite a retry that duplicates the event.
      if (!res.ok && UNSURE_CREATE.has(res.reason)) return { ...res, reason: 'maybe-created' };
      if (!res.ok) return res;
      const created = cal.parseCreate(res.answer);
      return created.created
        ? { ok: true, ...created, draft: checked.draft, costUsd: res.costUsd }
        : { ok: false, reason: 'not-created', costUsd: res.costUsd };
    })
  );
}

module.exports = { registerMissionIpc, localIsoNow };
