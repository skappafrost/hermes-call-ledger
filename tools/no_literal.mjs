/* Proves the page copy really lives in the message bundles: zero Vietnamese characters in the page code,
 * and every t('a.b') key resolvable in LOCALE_EN.
 *
 * A page that kept its strings inline would pass the render harness (the words are still on screen) and
 * fail here -- which is the point: Task 7 can only translate what the page stopped writing itself. */
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
/* The bundles are the destination, not unmigrated copy: Task 7 fills LOCALE_VI with Vietnamese right
 * here in plugin.js, because the loader forbids the separate locale files this would rather have. */
const page = src.replace(/\/\* BUNDLE-START \*\/[\s\S]*?\/\* BUNDLE-END \*\//, '')
const vi = [...page].filter(c => /[\u00C0-\u024F\u1E00-\u1EFF]/.test(c)).length

/* Only a complete literal key is checkable: `t('tab.' + k)` is assembled at the call site, so the lint
 * cannot know what it asks for. tests/locale.test.mjs walks those keys instead. */
const keys = [...page.matchAll(/\bt\('([A-Za-z0-9_.]+)'\s*[,)]/g)].map(m => m[1])
const leaf = k => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), ui.LOCALE_EN)
const missing = [...new Set(keys.filter(k => leaf(k) === undefined))]

console.log(`literal gate: ${vi} non-latin char(s) in plugin.js, ${missing.length} missing key(s)`
  + ` -- ${keys.length} t() call(s) checked against ${ui.LOCALE_VI ? Object.keys(ui.LOCALE_VI).length : 0} vi group(s)`)
if (missing.length) console.log('  missing:', missing.slice(0, 10))
process.exit(vi || missing.length ? 1 : 0)
