// ============================================================================
// LunaCore - widget registry (A2)
// ----------------------------------------------------------------------------
// A widget is a panel block that can be mounted into ANY slot and taken down
// again:
//
//   { id, titleKey, template, mount(root) -> cleanup? }
//
// This file is deliberately DOM-free. Mounting lives in host.js; here there is
// only the table and its validation, which keeps this half unit-testable (the
// same split that lets normalizeProfile / normalizeProject be tested in the main
// process).
//
// Why `titleKey` and not `title`: once a layout preset renders headers, a
// literal string would freeze the HUD into one language. The key is resolved
// through i18n at render time.
// ============================================================================

'use strict';

/**
 * Validates and normalises a widget spec.
 * Throws rather than returning null: a malformed widget is a programming error,
 * and it surfaces at import time - long before anything tries to mount it.
 */
export function normalizeWidget(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('widget: spec must be an object');
  }
  const id = typeof spec.id === 'string' ? spec.id.trim() : '';
  if (!id) throw new TypeError('widget: id is required');
  if (typeof spec.mount !== 'function') {
    throw new TypeError(`widget "${id}": mount() is required`);
  }
  return {
    id,
    // i18n key for the block header; '' means the markup carries its own.
    titleKey: typeof spec.titleKey === 'string' ? spec.titleKey.trim() : '',
    // id of a <template> in index.html holding this widget's markup; '' means
    // mount() builds its own DOM.
    template: typeof spec.template === 'string' ? spec.template.trim() : '',
    mount: spec.mount,
    // Defaults to true. `terminal` is the one exception (A2f): it owns live
    // xterm instances wired to real PTY processes, so a remount would clone a
    // brand-new EMPTY host from the template and orphan every running
    // session's DOM from its buffer. host.js's remountWidget() refuses when
    // this is false instead of doing that.
    remountable: spec.remountable !== false,
  };
}

/**
 * An isolated registry. Exported mainly so tests get a clean table each time
 * instead of sharing (and having to reset) module-level state.
 */
export function createRegistry() {
  const widgets = new Map();

  return {
    define(spec) {
      const widget = normalizeWidget(spec);
      if (widgets.has(widget.id)) {
        throw new Error(`widget "${widget.id}" is already defined`);
      }
      widgets.set(widget.id, widget);
      return widget;
    },
    get(id) {
      return widgets.get(id) || null;
    },
    has(id) {
      return widgets.has(id);
    },
    /** Definition order - which is also the order index.html declares them. */
    list() {
      return [...widgets.values()];
    },
    get size() {
      return widgets.size;
    },
  };
}

// The registry the app itself uses. Widgets self-register at import time.
const registry = createRegistry();

export function defineWidget(spec) {
  return registry.define(spec);
}

export function getWidget(id) {
  return registry.get(id);
}

export function listWidgets() {
  return registry.list();
}
