/* Gate for the Vietnamese bundle: the same keys, the same shapes, no English left behind.
 * Task 6 routed every UI string through `t()`, and `t()` answers a missing vi key out of the English
 * bundle -- which is exactly why a translation gap is invisible on screen. This file is the only thing
 * that makes a half-translated page fail a gate instead of shipping.
 *
 * The bundles live inside `desktop/plugin.js` (the Desktop loader refuses every import specifier outside
 * `@hermes/plugin-sdk` and `react*`, apps/desktop/src/contrib/runtime-loader.ts:332-358), so this test
 * reads them through the copy `tests/render_plugin.mjs` writes -- run that first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (!existsSync(fileURLToPath(new URL('./page-under-test.mjs', import.meta.url)))) {
  throw new Error('run `node tests/render_plugin.mjs` first — it generates page-under-test.mjs')
}
const ui = await import(new URL('./page-under-test.mjs', import.meta.url).href)

const BUNDLES = { en: ui.LOCALE_EN, vi: ui.LOCALE_VI }

/* The brief's key walk: a leaf is a string or a function, everything above it is a group. */
const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' ? keys(v, p + k + '.') : [p + k])
const at = (bundle, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), bundle)

test('en and vi carry exactly the same keys', () => {
  const e = keys(BUNDLES.en).sort(), v = keys(BUNDLES.vi).sort()
  assert.deepEqual(v, e, 'vi bundle differs from en')
})

/* Words the page deliberately prints in English because they are not English prose:
 * - a field name the store or vilao writes (`api_mode`, `health`), which a translation would misname;
 * - the product nouns the owner already reads on screen (`provider`, `model`, `cache`, `home`, `delay`),
 *   which Vietnamese technical writing borrows rather than invents;
 * - a unit or glyph the account itself writes (`vilao ↗`).
 *
 * The list is checked in both directions below: every term must actually be in use (so a term nobody
 * needs any more gets pruned instead of quietly exempting the next lazy copy), and a value on this list
 * may only be identical -- it can never excuse a whole sentence, which is what this gate is for. */
const TECH_TERMS = new Set([
  'provider', 'model', 'cache', 'home', 'delay', 'health', 'api_mode',
  'Session', 'Context', 'Reasoning', 'Provider / model', 'Vilao API key', 'key / provider', 'vilao ↗'
])

test('no vi value is an untranslated English copy', () => {
  const usedTerms = new Set()
  for (const k of keys(BUNDLES.vi)) {
    const v = at(BUNDLES.vi, k)
    if (typeof v !== 'string') continue
    const e = at(BUNDLES.en, k)
    if (typeof e === 'string' && /[a-z]{4}/.test(e) && v === e && !/^\W*\d/.test(v)) {
      assert.ok(TECH_TERMS.has(v), 'untranslated: ' + k + ' = ' + JSON.stringify(v))
      usedTerms.add(v)
    }
  }
  const stale = [...TECH_TERMS].filter(term => !usedTerms.has(term))
  assert.deepEqual(stale, [], 'TECH_TERMS entries nothing translates any more: ' + stale.join(', '))
})

/* Interpolators are part of the contract: `t('live.pager', page, pages, ...)` calls whatever it finds, so
 * a vi value that degraded to a string would throw at the call site (a string is not callable) and a vi
 * value that dropped an argument would print a sentence with a hole in it. Both are checked here rather
 * than left to whichever tab a reviewer happens to open. */
test('every vi interpolator is a function and survives the arguments its en twin takes', () => {
  const missed = [], broken = []
  for (const k of keys(BUNDLES.en)) {
    const e = at(BUNDLES.en, k)
    if (typeof e !== 'function') continue
    const v = at(BUNDLES.vi, k)
    if (typeof v !== 'function') { missed.push(k); continue }
    /* Four positional arguments cover every interpolator in the bundle; extras are simply ignored,
     * which is what makes this mechanical instead of a table of 60 call signatures. */
    const out = String(v(1, 2, 3, 4))
    if (!out || /undefined|NaN|\[object Object\]/.test(out)) broken.push(k + ' -> ' + out)
  }
  assert.deepEqual(missed, [], 'vi value is not a function: ' + missed.join(', '))
  assert.deepEqual(broken, [], 'vi interpolator lost an argument: ' + broken.join(', '))
})

/* A vi leaf that is a group in en (or vice versa) resolves through dig() to an object and would print
 * "[object Object]" on screen, so the tree shape is compared, not just the flattened key list. */
test('the two bundles have the same tree shape, leaf for leaf', () => {
  const shape = (o, p) => Object.entries(o).map(([k, v]) =>
    v && typeof v === 'object' ? shape(v, p + k + '.') : (p + k) + ':' + (typeof v === 'function' ? 'fn' : 'str'))
  assert.deepEqual(shape(BUNDLES.vi, '').sort(), shape(BUNDLES.en, '').sort())
})
