// ============================================================================
// LunaCore - the keyboard-shortcut reference (the list behind Ctrl+/)
// ----------------------------------------------------------------------------
// Every chord LunaCore claims is caught in one of four places: the window/tab
// chords in main.js's before-input-event handler, and the four overlay toggles
// plus the terminal's own key/wheel handling in the renderer modules. Nothing
// listed them for the user until now.
//
// This module owns the LIST, not the behaviour. It does not bind a single key -
// it only describes the ones that already exist, so the Ctrl+/ overlay
// (modules/shortcutspanel.js, which owns the DOM half) can print them. Each row carries a `source` marker string that test/shortcuts.test.js
// greps for in the file that actually implements the chord: rename or drop a
// binding and the test goes red until this table is brought back in step (the
// same drift guard modifiers.js / test/modifiers.test.js run against styles.css).
//
// No module-scope DOM reference (mirrors modifiers.js): `node --test` can
// require() this file for the data + the drift guard without a document.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

/**
 * The reference table. Groups render in this order; within a group, rows render
 * in this order.
 *
 * row.chords - array of ALTERNATIVES. Each alternative is an array of TOKENS
 *   rendered as <kbd>, joined by "+". Alternatives are joined by "/", so
 *   `[['Alt','<-'], ['Alt','->']]` prints `Alt+<- / Alt+->`.
 *   A token is a plain string, or `{ t: 'i18n.key' }` for a localized label
 *   (only "any key" needs that).
 * row.descKey - i18n key for the human description.
 * row.source  - { file, marker } for the drift guard: `marker` must appear
 *   verbatim in `file`, which is where the chord is actually implemented.
 */
export const SHORTCUT_GROUPS = [
  {
    id: 'window',
    titleKey: 'shortcuts.group.window',
    rows: [
      {
        chords: [['Ctrl', 'T']],
        descKey: 'shortcuts.newTab',
        source: { file: 'src/main.js', marker: "input.code === 'KeyT'" },
      },
      {
        chords: [['Ctrl', 'W']],
        descKey: 'shortcuts.closeTab',
        source: { file: 'src/main.js', marker: "input.code === 'KeyW'" },
      },
      {
        chords: [['Alt', '←']],
        descKey: 'shortcuts.prevTab',
        source: {
          file: 'src/main.js',
          marker: "input.code === 'ArrowLeft' || input.code === 'ArrowRight'",
        },
      },
      {
        chords: [['Alt', '→']],
        descKey: 'shortcuts.nextTab',
        source: {
          file: 'src/main.js',
          marker: "input.code === 'ArrowLeft' || input.code === 'ArrowRight'",
        },
      },
      {
        chords: [['Alt', '1…9']],
        descKey: 'shortcuts.jumpProject',
        source: { file: 'src/main.js', marker: 'jumpToProject(digit)' },
      },
    ],
  },
  {
    id: 'overlays',
    titleKey: 'shortcuts.group.overlays',
    rows: [
      {
        chords: [['Ctrl', 'K']],
        descKey: 'shortcuts.palette',
        source: {
          file: 'src/renderer/modules/palette.js',
          marker: "e.key === 'k' || e.key === 'K'",
        },
      },
      {
        chords: [['Ctrl', 'L']],
        descKey: 'shortcuts.settings',
        source: {
          file: 'src/renderer/modules/termcustom.js',
          marker: "e.key === 'l' || e.key === 'L'",
        },
      },
      {
        chords: [['Ctrl', 'G']],
        descKey: 'shortcuts.gitMenu',
        source: {
          file: 'src/renderer/modules/gitquick.js',
          marker: "e.key === 'g' || e.key === 'G'",
        },
      },
      {
        chords: [['Ctrl', '/']],
        descKey: 'shortcuts.shortcutsRef',
        source: {
          file: 'src/renderer/modules/shortcutspanel.js',
          marker: "e.key === '/'",
        },
      },
    ],
  },
  {
    id: 'terminal',
    titleKey: 'shortcuts.group.terminal',
    rows: [
      {
        chords: [['Ctrl', 'Shift', '← ↑ ↓ →']],
        descKey: 'shortcuts.mark',
        source: {
          file: 'src/renderer/modules/terminals.js',
          marker: 'event.ctrlKey && event.shiftKey && !event.altKey && arrow',
        },
      },
      {
        chords: [['Ctrl', 'C']],
        descKey: 'shortcuts.copySel',
        source: { file: 'src/renderer/modules/terminals.js', marker: 'isCopyChord' },
      },
      {
        chords: [['Ctrl', 'V']],
        descKey: 'shortcuts.pasteShot',
        source: {
          file: 'src/renderer/modules/terminals.js',
          marker: 'imageItem(event.clipboardData)',
        },
      },
      {
        chords: [['Shift', '↕']],
        descKey: 'shortcuts.pageTerm',
        source: {
          file: 'src/renderer/modules/terminals.js',
          marker: 'if (!event.shiftKey) return;',
        },
      },
    ],
  },
  {
    id: 'lists',
    titleKey: 'shortcuts.group.lists',
    rows: [
      {
        chords: [['Esc']],
        descKey: 'shortcuts.close',
        source: {
          file: 'src/renderer/modules/termcustom.js',
          marker: "e.key === 'Escape'",
        },
      },
      {
        chords: [['Enter'], ['Space']],
        descKey: 'shortcuts.activate',
        source: {
          file: 'src/renderer/modules/panels.js',
          marker: "e.key !== 'Enter' && e.key !== ' '",
        },
      },
      {
        chords: [['←'], ['→']],
        descKey: 'shortcuts.nudge',
        source: {
          file: 'src/renderer/modules/panels.js',
          marker: "e.key === 'ArrowLeft' ? -NUDGE_PX",
        },
      },
      {
        chords: [[{ t: 'shortcuts.anyKey' }]],
        descKey: 'shortcuts.skipBoot',
        source: { file: 'src/renderer/modules/boot.js', marker: 'skipBoot' },
      },
    ],
  },
];

/** Every row across every group, flattened - for the drift-guard test. */
export function flattenShortcuts() {
  return SHORTCUT_GROUPS.flatMap((g) => g.rows);
}

/** One <kbd>, its text either a literal token or a localized `{ t }` token. */
function kbd(token) {
  const el = document.createElement('kbd');
  el.textContent = typeof token === 'string' ? token : t(token.t);
  return el;
}

/** A chord cell: `<kbd>+<kbd>` per alternative, alternatives split by `/`. */
function chordCell(chords) {
  const cell = document.createElement('span');
  cell.className = 'shortcuts__keys';
  chords.forEach((alt, ai) => {
    if (ai > 0) {
      const or = document.createElement('span');
      or.className = 'shortcuts__or';
      or.textContent = '/';
      cell.appendChild(or);
    }
    alt.forEach((token, ti) => {
      if (ti > 0) {
        const plus = document.createElement('span');
        plus.className = 'shortcuts__plus';
        plus.textContent = '+';
        cell.appendChild(plus);
      }
      cell.appendChild(kbd(token));
    });
  });
  return cell;
}

/** Builds the whole list into `container` (cleared first). */
function render(container) {
  container.textContent = '';

  for (const group of SHORTCUT_GROUPS) {
    const section = document.createElement('div');
    section.className = 'shortcuts__group';

    const title = document.createElement('div');
    title.className = 'shortcuts__grouptitle';
    title.textContent = t(group.titleKey);
    section.appendChild(title);

    for (const row of group.rows) {
      const line = document.createElement('div');
      line.className = 'shortcuts__row';

      const desc = document.createElement('span');
      desc.className = 'shortcuts__desc';
      desc.textContent = t(row.descKey);

      line.append(chordCell(row.chords), desc);
      section.appendChild(line);
    }

    container.appendChild(section);
  }

  const note = document.createElement('p');
  note.className = 'shortcuts__note';
  note.textContent = t('shortcuts.macNote');
  container.appendChild(note);
}

/**
 * Fills `#shortcuts-list` inside the Ctrl+/ overlay and re-renders it on a
 * language change. Called once from shortcutspanel.js, on its first open.
 * A no-op when the container is absent (e.g. the --luna-probe harness), same
 * defensiveness as mountPaletteChip().
 *
 * @param {ParentNode} [root] where to look for `#shortcuts-list`
 */
export function mountShortcuts(root = document) {
  const container = root.querySelector('#shortcuts-list');
  if (!container) return;
  render(container);
  onLangChange(() => render(container));
}
