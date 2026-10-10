/** Render every tab of the Call Ledger page outside Electron, against the synthetic route payloads.
 *
 * `node --check` only proves the file parses. This proves the components run on the shapes the routes
 * actually return -- and it has already caught a duplicate top-level `const`, an undefined variable in
 * LiveTab, and a style value passed where a DOM attribute belongs, none of which the parser reports.
 *
 * Each component is rendered twice, once per locale (en, then vi), and a locale whose marker strings are
 * not on screen is a failure: the render is the only gate that sees the page the way the reader does.
 *
 * It reads no store and opens no socket: the data comes from tests/fixtures.json (tests/dump_fixtures.py
 * writes it from a temporary home), and the only thing taken from the Hermes checkout is React itself.
 */
import * as io from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const NM = join(process.env.HERMES_AGENT_DIR
  || (process.env.LOCALAPPDATA || '') + '/hermes/hermes-agent', 'node_modules')
const url = p => pathToFileURL(p).href

if (!io.existsSync(join(NM, 'react'))) {
  console.log('no React at ' + NM + '; set HERMES_AGENT_DIR=/path/to/hermes-agent')
  process.exit(2)
}

let src = io.readFileSync(join(here, '../desktop/plugin.js'), 'utf-8')
/* The real api() is async because react-query awaits it; the fixture bridge answers synchronously, so
 * the copy under test drops the keyword -- otherwise every query hands the components a Promise. */
src = src
  .replace('async function api(', 'function api(')
  .replace("'@hermes/plugin-sdk'", JSON.stringify(url(join(here, 'sdk-stub.mjs'))))
  .replace("'react/jsx-runtime'", JSON.stringify(url(join(NM, 'react/jsx-runtime.js'))))
  .replace("'react'", JSON.stringify(url(join(NM, 'react/index.js'))))
src += '\nexport { LiveTab, TrendTab, LogTab, QuotaTab, WalletTab, KeysTab, ModelsTab, Page, Calendar, '
  + 'Lines, Pager, sortRows, csvOf, cellValue, nextSort, pageList, priceDelta, netPrice, effectivePrice, '
  + 'MODEL_COLS, SESSION_COLS, LOG_MODEL_COLS, KEY_COLS, PROVIDER_COLS, safeExternal, '
  + 'LOCALE_EN, LOCALE_VI, resolve, setLang, lang, t, formatMoney, dong, est }\n'
io.writeFileSync(join(here, 'page-under-test.mjs'), src, 'utf-8')

const stub = await import(url(join(here, 'sdk-stub.mjs')))
const { jsx } = await import(url(join(NM, 'react/jsx-runtime.js')))
const server = await import(url(join(NM, 'react-dom/server.node.js')))
const renderToString = server.renderToString || (server.default && server.default.renderToString)
if (typeof renderToString !== 'function') {
  console.log('no renderToString; exports:', Object.keys(server).slice(0, 8).join(','))
  process.exit(2)
}
const page = await import(url(join(here, 'page-under-test.mjs')))

/* One string per tab that only exists if the tab actually drew its main widget. Length alone would
 * report "ok" for a component that rendered a card and an empty state, which is exactly the bug a
 * refactor of the shared table can introduce.
 *
 * The set is per locale, because the page has two: the English markers are the copy LOCALE_EN gives the
 * default reader, and the Vietnamese ones are the same widgets' copy in LOCALE_VI. A header that stayed
 * English under `vi` fails twice over -- its Vietnamese marker is missing from the html, and the English
 * marker it should have replaced is still there. Both are checked below.
 *
 * `T1→T12` is the one marker that is not a translation of its English twin: the year grid names its
 * months `T1`…`T12` in Vietnamese because twelve three-letter labels do not fit over 53 columns. */
const MUST = {
  en: {
    Live: 'filter model', Trend: 'Jan→Dec', Log: 'Usage per day', Quota: 'peak rpm',
    Wallet: 'Your vilao API keys', Keys: 'this key', Models: 'offers on sale', Page: 'Call ledger'
  },
  vi: {
    Live: 'lọc model', Trend: 'T1→T12', Log: 'Usage mỗi ngày', Quota: 'đỉnh rpm',
    Wallet: 'API key của bạn trên vilao', Keys: 'Key này đã trả', Models: 'offer đang bán',
    Page: 'Sổ chi phí gọi'
  }
}
const COMPONENTS = {
  Live: page.LiveTab, Trend: page.TrendTab, Log: page.LogTab, Quota: page.QuotaTab,
  Wallet: page.WalletTab, Keys: page.KeysTab, Models: page.ModelsTab, Page: page.Page
}
const SUSPECTS = []

/* register() is what hands the page its rest bridge; without it every query answers "not mounted". */
page.default.register({ rest: stub.fixtureRest, registerMany: () => {}, onDispose: () => {} })

for (const loc of ['en', 'vi']) {
  /* Two switches, one language: `setLang` is what the page's own resolver answers with once Page has
   * rendered, and `__stubLocale` is the app locale the stub hands `useI18n` -- the settings fixture says
   * `auto`, so the page must follow the app, exactly as it does on a real machine. */
  globalThis.__stubLocale = loc
  page.setLang(loc)
  for (const [name, Comp] of Object.entries(COMPONENTS)) {
    try {
      const html = renderToString(jsx(Comp, {}))
      const bad = /(>undefined|>NaN|\[object Object\]|var\(--[a-z-]+, undefined)/.exec(html)
      const clock = />(\d\d:\d\d:\d\d)</.exec(html)
      /* The money the page drew, whatever unit it drew it in: dong prints as `500.000 ₫` (the account's
       * own writing, from Intl.NumberFormat) and dollars as `$0.02`, and a dash means the page had no
       * rate to print -- which is an answer, not a bug. The symbol is what makes this match money and not
       * some other number on the screen. */
      const dong = /(₫[\d.,]+|[\d.,]+\s+₫|\$[\d.,]+)/.exec(html)
      const want = MUST[loc][name]
      const other = MUST[loc === 'en' ? 'vi' : 'en'][name]
      const missing = want && !html.includes(want) ? 'MISSING[' + want + ']' : ''
      const stale = want && html.includes(other) ? 'ENGLISH_LEFT[' + other + ']' : ''
      if (process.env.DUMP) io.writeFileSync(join(here, 'tab-' + name + '-' + loc + '.html'), html, 'utf-8')
      /* Padded by hand: console.log has no C-style width specifiers, so the format string that used to sit
       * here was printed literally and ran the values together (`Live223835ok`). The gate is exit-code and
       * SUSPECTS based, so it was never wrong -- this is only the difference between a log and a wall. */
      const status = bad || missing || stale
        ? 'SUSPECT ' + (bad ? bad[0] : (missing || stale)) : 'ok'
      console.log([loc.padEnd(4), name.padEnd(9), (html.length + ' chars').padStart(13),
        status.padEnd(30), clock ? 'clock=' + clock[1] : '', dong ? 'money=' + dong[1] : '']
        .filter(Boolean).join(' '))
      if (bad || missing || stale) SUSPECTS.push(loc + '/' + name + ': ' + (bad ? bad[0] : (missing || stale)))
    } catch (err) {
      console.log(loc.padEnd(4) + name.padEnd(9) + ' THREW ' + String(err && err.message).slice(0, 130))
      SUSPECTS.push(loc + '/' + name + ' threw: ' + String(err && err.message).slice(0, 90))
    }
  }
}
/* Money on a machine that has never fetched a rate (spec §6.1: no FX available means print nothing,
 * never an invented conversion). Each row asks for one unit and forbids the other symbol entirely: a
 * `₫` on the dollar page would be a dong figure produced without a rate, and a `$` on the dong page would
 * be a dollar estimate the page had quietly converted. The English page is used because the Vietnamese
 * column headers carry a dong sign of their own, which is copy and not money. */
globalThis.__stubNoFx = true
globalThis.__stubLocale = 'en'
for (const [label, currency, own, forbidden] of [
  ['no rate, asks for dong', 'auto', '₫', '$'],
  ['no rate, asks for dollars', 'usd', '$', '₫']
]) {
  globalThis.__stubSettingsCurrency = currency
  page.setLang('en')
  const html = renderToString(jsx(page.Page, {}))
  const bad = !html.includes(own) || html.includes(forbidden)
  console.log(label.padEnd(30) + (bad ? ' SUSPECT the page printed ' + (html.includes(forbidden)
    ? forbidden + ' with no rate to convert with' : 'no ' + own + ' at all') : 'ok'))
  if (bad) SUSPECTS.push(label + ': money printed a unit it had no rate for')
}
delete globalThis.__stubNoFx
delete globalThis.__stubSettingsCurrency

/* The Models tab when the price list could not be read. The catalogue is a public page and this plugin
 * fetches it without a credential, so the only honest causes are "vilao did not answer" or "the search
 * excluded every offer" -- and the copy has to tell those two apart. A tab that answers a failed fetch
 * with "No offer matches these filters" sends a reader with no billing provider off to hunt for a filter
 * they never set. The assertions read the bundle rather than repeating a sentence, so they outlive any
 * rewording and still fail if the two states collapse back into one message. */
globalThis.__stubCatalogError = 'catalog unreachable: connect timeout'
page.setLang('en')
const noCatalog = renderToString(jsx(page.ModelsTab, {}))
const blamedFilters = noCatalog.includes(page.LOCALE_EN.models.empty)
const namedTheFetch = noCatalog.includes(page.LOCALE_EN.models.noOffers)
console.log('price list unread, not filter-blaming'
  + (blamedFilters || !namedTheFetch ? ' SUSPECT the tab blamed the reader for a fetch that failed' : 'ok'))
if (blamedFilters || !namedTheFetch) {
  SUSPECTS.push('Models: an unread price list was reported as the reader\'s filters')
}
delete globalThis.__stubCatalogError

const fails = globalThis.__renderFailures || []

/* The resolution itself, proven behaviourally rather than by reading the source. A `Page` whose app
 * locale says `vi` must paint Vietnamese on its FIRST render even when the module language still says
 * `en` -- which is only true because Page computes `setLang(resolve(appLocale, settings.language))` in its
 * render body. Move that into an effect and this fails: renderToString never runs effects, so the html
 * keeps the language it was handed, and a Vietnamese reader's first frame is English.
 *
 * The third case is the one that proves the route is consulted at all: the app says English, the reader's
 * setting says Vietnamese, and the setting wins. */
const flip = (appLocale, preset, language) => {
  globalThis.__stubLocale = appLocale
  globalThis.__stubSettingsLanguage = language
  page.setLang(preset)
  try {
    return renderToString(jsx(page.Page, {}))
  } finally {
    delete globalThis.__stubSettingsLanguage
  }
}
for (const [label, html, want, other] of [
  ['Page app=vi lang=en', flip('vi', 'en'), MUST.vi.Page, MUST.en.Page],
  ['Page app=en lang=vi', flip('en', 'vi'), MUST.en.Page, MUST.vi.Page],
  ['setting vi beats app en', flip('en', 'en', 'vi'), MUST.vi.Page, MUST.en.Page]
]) {
  const bad = !html.includes(want) || html.includes(other)
  console.log(label.padEnd(30) + (bad ? ' SUSPECT the first render did not answer the reader'
    + ' (wanted ' + want + ', saw ' + (html.includes(other) ? other : 'nothing of it') + ')' : 'ok'))
  if (bad) SUSPECTS.push(label + ': the first render did not answer the reader')
}

console.log('query failures:', fails.length ? fails.slice(0, 5).join(' | ') : 'none')
/* A harness that always exits 0 is a harness nobody reads. */
if (SUSPECTS.length || fails.length) {
  console.log('RENDER FAILED:', SUSPECTS.join(' | ') || 'query errors')
  process.exit(1)
}
