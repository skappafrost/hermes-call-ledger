/* Gate for the plugin's message layer: resolution, the English fallback, and the interpolators.
 *
 * The loader forbids every import specifier outside @hermes/plugin-sdk / react, so the bundles and the
 * resolver live inside desktop/plugin.js and reach this test through the copy tests/render_plugin.mjs
 * writes -- which is also where the export line decides what a test may see.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!existsSync(fileURLToPath(new URL('./page-under-test.mjs', import.meta.url)))) {
  throw new Error('run `node tests/render_plugin.mjs` first — it generates page-under-test.mjs')
}
const ui = await import(new URL('./page-under-test.mjs', import.meta.url).href)
const { resolve, t, setLang, lang, LOCALE_EN: EN, LOCALE_VI: VI } = ui
const BUNDLES = { en: EN, vi: VI }
/* The same dotted-path lookup the plugin does, so an assertion can name the value it expects to win
 * whether or not `vi` has a leaf yet (Task 7 fills it; until then every vi read falls through to en). */
const leaf = (bundle, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), bundle)

test('auto follows the app locale, en/vi override it', () => {
  assert.equal(resolve('fr', 'auto'), 'fr')
  assert.equal(resolve('fr', 'vi'), 'vi')
  assert.equal(resolve('fr', 'en'), 'en')
  assert.equal(resolve('fr', ''), 'fr')
})

test('the override is case and space insensitive', () => {
  assert.equal(resolve('fr', ' VI '), 'vi')
  assert.equal(resolve('fr', 'EN'), 'en')
  assert.equal(resolve('', 'nonsense'), 'en')
})

test('a missing bundle falls back to English, then to the key', () => {
  setLang('de')
  assert.equal(lang(), 'de')
  assert.equal(t('tab.live'), BUNDLES.en.tab.live)
  setLang('vi')
  assert.equal(t('tab.live'), leaf(BUNDLES.vi, 'tab.live') ?? leaf(BUNDLES.en, 'tab.live'))
  assert.equal(t('nope.nope'), 'nope.nope')
})

test('interpolators take positional args', () => {
  setLang('en')
  assert.match(t('live.pager', 3, 42, 100, 25), /3/)
  assert.match(t('live.pager', 3, 42, 100, 25), /42/)
  assert.equal(typeof t('trend.yearGrid', 2026), 'string')
  assert.match(t('trend.yearGrid', 2026), /2026/)
})

/* `t('tab.' + k)` is built at the call site, so the no-literal lint cannot see the key it produces.
 * This is what proves the seven tabs the shell can switch to each have a label — a missing one would
 * paint an undefined tab button, which the render harness would only catch by luck. */
test('every tab key resolves instead of echoing the key', () => {
  setLang('en')
  for (const k of ['live', 'trend', 'log', 'quota', 'wallet', 'keys', 'models']) {
    const label = t('tab.' + k)
    assert.notEqual(label, 'tab.' + k, 'no label for tab ' + k)
    assert.doesNotMatch(label, /undefined/)
  }
})

/* t() stringifies anything that is not a function, so a key that lands on a group instead of a leaf
 * would print [object Object] on screen. Walking the bundle proves every leaf is a message and that
 * every message is reachable by its own dot path. */
test('every en leaf is a string or a function, and resolves by its key', () => {
  const leaves = []
  const walk = (o, path) => {
    if (typeof o === 'function' || typeof o === 'string') { leaves.push([path, o]); return }
    assert.ok(o && typeof o === 'object', 'unexpected leaf type at ' + path)
    for (const [k, v] of Object.entries(o)) walk(v, path ? path + '.' + k : k)
  }
  walk(EN, '')
  assert.ok(leaves.length >= 7, 'the en bundle is suspiciously small: ' + leaves.length)
  setLang('en')
  for (const [path, value] of leaves) {
    assert.notEqual(typeof value, 'number', 'a number leaf would not survive an i18n merge: ' + path)
    if (typeof value !== 'string') continue
    assert.equal(t(path), value, 'key does not resolve to its en message: ' + path)
    assert.doesNotMatch(value, /undefined/, 'en message carries the word undefined: ' + path)
  }
})
