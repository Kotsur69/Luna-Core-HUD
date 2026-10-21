// ============================================================================
// LunaCore - host first-run setup (src/hostsetup.js)
// ----------------------------------------------------------------------------
// The setup decision (login first, then pairing; only 'ready' heartbeats and
// claims commands), the pl/en strings and the pairing dialog's answer.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideSetup, hostText, langOf, setupLine, spacedCode, confirmPairing, STRINGS } = require('../src/hostsetup');

test('decideSetup: no cloud, then login, then pairing, then ready', () => {
  assert.equal(decideSetup({ configured: false, loggedIn: false, paired: false }), 'no-cloud');
  assert.equal(decideSetup({ configured: false, loggedIn: true, paired: true }), 'no-cloud');
  assert.equal(decideSetup({ configured: true, loggedIn: false, paired: false }), 'login');
  assert.equal(decideSetup({ configured: true, loggedIn: false, paired: true }), 'login', 'a paired phone without a session still needs the login');
  assert.equal(decideSetup({ configured: true, loggedIn: true, paired: false }), 'pair');
  assert.equal(decideSetup({ configured: true, loggedIn: true, paired: true }), 'ready');
});

test('strings: pl and en have the same keys, pl without diacritics', () => {
  assert.deepEqual(Object.keys(STRINGS.pl).sort(), Object.keys(STRINGS.en).sort());
  for (const text of Object.values(STRINGS.pl)) assert.doesNotMatch(text, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/);
});

test('hostText fills placeholders; langOf maps locales', () => {
  assert.equal(hostText('en', 'pairMessage', { code: '123 456' }), 'Code: 123 456');
  assert.equal(hostText('xx', 'stop'), 'Stop');
  assert.equal(hostText('en', 'pairMessage'), 'Code: {code}', 'a missing value stays visible');
  assert.equal(langOf('pl-PL'), 'pl');
  assert.equal(langOf('en-US'), 'en');
  assert.equal(langOf(undefined), 'en');
  assert.equal(setupLine('en', 'pair'), 'Pair a phone');
  assert.equal(setupLine('pl', 'login'), 'Zaloguj sie do chmury (GitHub)');
  assert.equal(spacedCode('042917'), '042 917');
});

test('confirmPairing: only the Confirm button pairs; Reject is the default', async () => {
  let opts = null;
  const dialog = (response) => ({
    showMessageBox: async (o) => {
      opts = o;
      return { response };
    },
  });
  assert.equal(await confirmPairing({ dialog: dialog(0), lang: 'en', machine: 'MAC-1', code: '042917', label: 'iPhone' }), true);
  assert.equal(opts.message, 'Code: 042 917');
  assert.match(opts.detail, /iPhone.*MAC-1/);
  assert.equal(opts.defaultId, 1);
  assert.equal(opts.cancelId, 1);
  assert.equal(await confirmPairing({ dialog: dialog(1), lang: 'en', machine: 'MAC-1', code: '042917', label: 'iPhone' }), false);
});
