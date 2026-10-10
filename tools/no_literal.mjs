/* Proves the page copy really lives in the message bundles: no Vietnamese characters anywhere except
 * inside LOCALE_VI, and every t('a.b') key resolvable in LOCALE_EN.
 *
 * A page that kept its strings inline would pass the render harness (the words are still on screen) and
 * fail here -- which is the point: Task 7 can only translate what the page stopped writing itself.
 *
 * The scope of the count moved in Task 7. It used to be "everything outside the BUNDLE-START..BUNDLE-END
 * block", which was honest only while LOCALE_VI was empty; now that the Vietnamese bundle exists, that
 * block holds both bundles and would also forgive Vietnamese in LOCALE_EN (an English page for a
 * Vietnamese reader) or in the code under it. So the exempt range is the LOCALE_VI literal itself: its
 * declaration line through the lone `}` that closes it, both found by exact text, and the gate fails
 * rather than guesses if either marker is missing. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const plugin = join(root, 'desktop', 'plugin.js')
const gen = join(root, 'tests', 'page-under-test.mjs')

if (!existsSync(gen)) {
  console.log('literal gate: ' + gen + ' is missing -- run `node tests/render_plugin.mjs` first')
  process.exit(1)
}
/* The key check reads LOCALE_EN out of the generated copy, so a copy older than the page would report
 * green against strings that are no longer there. */
if (statSync(plugin).mtimeMs > statSync(gen).mtimeMs) {
  console.log('literal gate: desktop/plugin.js is newer than tests/page-under-test.mjs'
    + ' -- run `node tests/render_plugin.mjs` first')
  process.exit(1)
}
const ui = await import(pathToFileURL(gen).href)

const src = readFileSync(plugin, 'utf-8')
/* Split on either line ending: a checkout on Windows carries CRLF, an editor or a patch may rewrite a
 * line with LF, and a range rule that only understands one of the two reads the closing brace of the
 * bundle as `}\r` and refuses to count anything. */
const lines = src.split(/\r?\n/)
const NON_LATIN = /[\u00C0-\u024F\u1E00-\u1EFF]/
const count = list => list.filter(l => l != null).reduce((n, l) => n + [...l].filter(c => NON_LATIN.test(c)).length, 0)

/* --- the Vietnamese-literal range, by exact line, never by a guessed offset --------------------- */
const from = lines.findIndex(l => l.startsWith('const LOCALE_VI = {'))
if (from < 0) {
  console.log('literal gate: no `const LOCALE_VI = {` line in plugin.js -- the exempt range is gone,'
    + ' so this gate cannot say where Vietnamese is allowed')
  process.exit(1)
}
const to = lines.findIndex((l, i) => i > from && l === '}')
if (to < 0) {
  console.log('literal gate: the LOCALE_VI literal never closes at line 0 on its own line (line '
    + (from + 1) + ') -- refusing to count')
  process.exit(1)
}
const inside = lines.slice(from, to + 1)
const outside = lines.slice(0, from).concat(lines.slice(to + 1))
const vi = count(outside)
const viChars = count(inside)

/* --- every t() key the page asks for has to exist in the English bundle -------------------------- */
/* Key extraction still skips the whole bundle block, and for a different reason than the count: a
 * message body is not a call site, and the bundles are full of text like "sort by" that must not be
 * mined for keys. */
const page = src.replace(/\/\* BUNDLE-START \*\/[\s\S]*?\/\* BUNDLE-END \*\//, '')
const keys = [...page.matchAll(/\bt\('([A-Za-z0-9_.]+)'\s*[,)]/g)].map(m => m[1])
const leaf = k => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), ui.LOCALE_EN)
const missing = [...new Set(keys.filter(k => leaf(k) === undefined))]

console.log(`literal gate: ${vi} non-latin char(s) outside LOCALE_VI (lines ${from + 1}-${to + 1}, `
  + `which holds ${viChars}), ${missing.length} missing key(s)`
  + ` -- ${keys.length} t() call(s) checked against ${Object.keys(ui.LOCALE_VI).length} vi group(s)`)
if (missing.length) console.log('  missing:', missing.slice(0, 10))
if (!viChars) console.log('  literal gate: LOCALE_VI holds no Vietnamese at all -- the bundle is empty')
process.exit(vi || missing.length || !viChars ? 1 : 0)
