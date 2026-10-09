/** Render every tab of the Call Ledger page outside Electron, against the synthetic route payloads.
 *
 * `node --check` only proves the file parses. This proves the components run on the shapes the routes
 * actually return -- and it has already caught a duplicate top-level `const`, an undefined variable in
 * LiveTab, and a style value passed where a DOM attribute belongs, none of which the parser reports.
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
  + 'LOCALE_EN, LOCALE_VI, resolve, setLang, lang, t }\n'
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
 * These are English because the page speaks English by default (desktop/plugin.js LOCALE_EN). Each one
 * moves in the same commit that moves the string it names, so a tab that stops drawing its main widget
 * still fails here instead of matching a string that no longer exists anywhere. */
const MUST = {
  Live: 'filter model', Trend: 'Jan→Dec', Log: 'Usage per day', Quota: 'peak rpm',
  Wallet: 'Your vilao API keys', Keys: 'this key', Models: 'offers on sale', Page: 'Call ledger'
}
const SUSPECTS = []

/* register() is what hands the page its rest bridge; without it every query answers "not mounted". */
page.default.register({ rest: stub.fixtureRest, registerMany: () => {}, onDispose: () => {} })

for (const [name, Comp] of Object.entries({
  Live: page.LiveTab, Trend: page.TrendTab, Log: page.LogTab, Quota: page.QuotaTab, Wallet: page.WalletTab,
  Keys: page.KeysTab, Models: page.ModelsTab, Page: page.Page
})) {
  try {
    const html = renderToString(jsx(Comp, {}))
    const bad = /(>undefined|>NaN|\[object Object\]|var\(--[a-z-]+, undefined)/.exec(html)
    const clock = />(\d\d:\d\d:\d\d)</.exec(html)
    const dong = /(₫?[\d.,]+\s*(?:đ|dong))/.exec(html)
    const missing = MUST[name] && !html.includes(MUST[name]) ? 'MISSING[' + MUST[name] + ']' : ''
    if (process.env.DUMP) io.writeFileSync(join(here, 'tab-' + name + '.html'), html, 'utf-8')
    /* Padded by hand: console.log has no C-style width specifiers, so the format string that used to sit
     * here was printed literally and ran the values together (`Live223835ok`). The gate is exit-code and
     * SUSPECTS based, so it was never wrong -- this is only the difference between a log and a wall. */
    const status = bad || missing ? 'SUSPECT ' + (bad ? bad[0] : missing) : 'ok'
    console.log([name.padEnd(10), (html.length + ' chars').padStart(13), status.padEnd(26),
      clock ? 'clock=' + clock[1] : '', dong ? 'money=' + dong[1] : ''].filter(Boolean).join(' '))
    if (bad || missing) SUSPECTS.push(name + ': ' + (bad ? bad[0] : missing))
  } catch (err) {
    console.log(name.padEnd(10) + ' THREW ' + String(err && err.message).slice(0, 130))
    SUSPECTS.push(name + ' threw: ' + String(err && err.message).slice(0, 90))
  }
}
const fails = globalThis.__renderFailures || []
console.log('query failures:', fails.length ? fails.slice(0, 5).join(' | ') : 'none')
/* A harness that always exits 0 is a harness nobody reads. */
if (SUSPECTS.length || fails.length) {
  console.log('RENDER FAILED:', SUSPECTS.join(' | ') || 'query errors')
  process.exit(1)
}
