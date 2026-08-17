// ============================================================================
// LunaCore - IPC feeds (A2)
// ----------------------------------------------------------------------------
// One listener per process-wide IPC channel, re-emitted on the bus.
//
// WHY this module exists at all: preload exposes subscriptions as bare
// `ipcRenderer.on(...)` with NO way to remove them (see preload.js onPorts /
// onUsage). Before widgets that was harmless - nothing was ever torn down. The
// moment a block can be unmounted and mounted again, a widget subscribing to IPC
// directly would leave the old handler behind and end up rendering twice per
// tick, with no way to undo it.
//
// So the rule A2 establishes is: IPC listeners live HERE, at module scope, and
// widgets only ever touch the bus - whose subscriptions do come with disposers.
//
// sessions.js keeps its own IPC listeners deliberately. It is not a widget but
// the session router: it has to demultiplex every payload by sessionId before
// anyone else can use it, and it already fans the result out through the bus.
// ============================================================================

'use strict';

import {
  emitPortsUpdate,
  emitUsageUpdate,
  emitUpdateState,
  emitTelemetryUpdate,
  emitMediaUpdate,
  emitClipboardUpdate,
} from './bus.js';

// 7B: passive scan of listening localhost ports.
window.lunacore.onPorts((ports) => {
  emitPortsUpdate(Array.isArray(ports) ? ports : []);
});

// Usage limits (5h + weekly). Account-scoped, NOT per tab - see the scope rule
// in README: context window is per process, usage limits are per account.
window.lunacore.onUsage((usage) => {
  emitUsageUpdate(usage);
});

// D5: update availability. App-scoped like usage, not per tab - there is one
// LunaCore binary no matter how many sessions are open.
window.lunacore.onUpdateState((state) => {
  emitUpdateState(state);
});

// E1: machine telemetry. App-scoped like the two above - there is one machine
// no matter how many tabs are open, so this must NOT go through sessions.js.
window.lunacore.onTelemetry((sample) => {
  emitTelemetryUpdate(sample);
});

// Media Deck: now-playing (GSMTC) + system volume. App-scoped like the three
// above - one Windows box, one "current" media session, no matter how many
// tabs are open - so this must NOT go through sessions.js either.
window.lunacore.onMedia((state) => {
  emitMediaUpdate(state);
});

// Clipboard history. App-scoped like the four above - one system clipboard, no
// matter how many tabs are open. Fires only while the watcher is enabled; when
// it is off this channel simply stays silent (see src/clipboard.js).
window.lunacore.onClipboard((list) => {
  emitClipboardUpdate(Array.isArray(list) ? list : []);
});
