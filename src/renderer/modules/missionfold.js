// ============================================================================
// LunaCore - Mission Control: foldable section titles
// ----------------------------------------------------------------------------
// Every static `.mc-bucket` title (an <h3> in the widget templates) becomes a
// toggle: click or Enter/Space folds the section down to its title and back.
// The state is remembered per section in localStorage, keyed by the title's
// i18n key, so a section Mati folded stays folded. The Trending header has its
// own fold (missiontrending.js) and is skipped. Dynamic titles (<h4>, built per
// scan or per list) are not touched.
// ============================================================================

'use strict';

const KEY_PREFIX = 'lunacore.mc.fold.';

function readFolded(key) {
  try {
    return localStorage.getItem(KEY_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function writeFolded(key, folded) {
  try {
    if (folded) localStorage.setItem(KEY_PREFIX + key, '1');
    else localStorage.removeItem(KEY_PREFIX + key);
  } catch {
    // Storage can be blocked; the fold still works for this session.
  }
}

function foldSection(section, head) {
  const key = head.dataset.i18n;
  if (!key) return;
  // i18n rewrites textContent of [data-i18n] nodes, which would wipe the
  // chevron - so the label moves into its own span and the title keeps both.
  const label = document.createElement('span');
  label.dataset.i18n = key;
  label.textContent = head.textContent;
  head.removeAttribute('data-i18n');
  const chevron = document.createElement('span');
  chevron.className = 'panel__fold';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  head.replaceChildren(chevron, label);
  head.classList.add('panel__title--fold');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;

  const apply = (folded) => {
    if (folded) section.setAttribute('data-collapsed', '');
    else section.removeAttribute('data-collapsed');
    head.setAttribute('aria-expanded', String(!folded));
  };
  const toggle = () => {
    const folded = !section.hasAttribute('data-collapsed');
    apply(folded);
    writeFolded(key, folded);
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
  apply(readFolded(key));
}

/**
 * Make every static section title under `root` fold its section.
 * @param {HTMLElement} root a widget root
 */
export function foldBuckets(root) {
  for (const head of root.querySelectorAll('section.mc-bucket > h3.mc-bucket__title')) {
    if (head.classList.contains('panel__title--fold')) continue;
    foldSection(head.parentElement, head);
  }
}
