/* Unit gate for the pure helpers the table code depends on.
 *
 * The render harness proves a component renders; it cannot prove a sort is stable, that a CSV field
 * containing a comma is quoted, or that clicking a header three times returns to the unsorted view.
 * Those are functions, so they get function tests, against the same module the harness rendered
 * (run `node tests/render_plugin.mjs` first -- it writes the copy under test).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const url = p => pathToFileURL(p).href
const target = join(here, 'page-under-test.mjs')
if (!existsSync(target)) {
  console.log('no ' + target + ' yet; run: node tests/render_plugin.mjs')
  process.exit(2)
}
const ui = await import(url(target))
/* The gate below asserts English strings, and every label the column lists carry comes from the bundle,
 * so pin the language instead of inheriting whatever the last import left it at. */
ui.setLang('en')

let fails = 0
const check = (name, cond, detail) => {
  if (cond) { console.log('ok   ' + name); return }
  fails++
  console.log('FAIL ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)))
}

/* --- sorting --------------------------------------------------------------------------- */
const cols = [
  { label: 'n', sort: r => Number(r.n), render: r => String(r.n) },
  { label: 's', sort: r => String(r.s), render: r => r.s },
  { label: 'plain', render: r => 'x' }
]
const rows = [{ n: 3, s: 'b' }, { n: 10, s: 'a' }, { n: 3, s: 'c' }]
const desc = ui.sortRows(rows, cols, { label: 'n', dir: -1 })
check('numeric sort is numeric not lexical', desc.map(r => r.n).join() === '10,3,3', desc.map(r => r.n))
check('ties keep input order (stable)', desc[1].s === 'b' && desc[2].s === 'c', desc.map(r => r.s))
check('ascending reverses', ui.sortRows(rows, cols, { label: 'n', dir: 1 }).map(r => r.n).join() === '3,3,10')
check('text column sorts by locale', ui.sortRows(rows, cols, { label: 's', dir: 1 }).map(r => r.s).join() === 'a,b,c')
check('a column without a sort accessor leaves the rows alone',
  ui.sortRows(rows, cols, { label: 'plain', dir: -1 }) === rows)
check('no sort state returns the same array', ui.sortRows(rows, cols, null) === rows)

/* --- header click cycles ---------------------------------------------------------------- */
check('first click sorts descending', JSON.stringify(ui.nextSort(null, 'n')) === '{"label":"n","dir":-1}')
check('second click reverses', JSON.stringify(ui.nextSort({ label: 'n', dir: -1 }, 'n')) === '{"label":"n","dir":1}')
check('third click clears', ui.nextSort({ label: 'n', dir: 1 }, 'n') === null)
check('clicking another column starts it descending',
  JSON.stringify(ui.nextSort({ label: 'n', dir: 1 }, 's')) === '{"label":"s","dir":-1}')

/* --- CSV ------------------------------------------------------------------------------- */
const csvCols = [
  { label: 'a,b', raw: () => 'x,y' },
  { label: 'quote', raw: () => 'he said "hi"' },
  { label: 'multiline', raw: () => 'l1\nl2' },
  { label: 'number', sort: r => r.n, render: r => String(r.n) },
  { label: 'vnode', render: () => ({ type: 'a' }) },
  { label: 'vnode with raw', raw: r => r.n, render: () => ({ type: 'a' }) }
]
const csv = ui.csvOf(csvCols, [{ n: 7 }])
const lines = csv.split('\r\n')
check('header row quoted where the label has a comma', lines[0].startsWith('"a,b",'), lines[0])
check('comma escaped', lines[1].startsWith('"x,y",'), lines[1])
check('quotes doubled', lines[1].includes('"he said ""hi"""'), lines[1])
check('newline field quoted', lines[1].includes('"l1\nl2"'), lines[1])
check('sort accessor used when there is no raw', lines[1].includes(',7,'), lines[1])
check('a vnode never prints [object Object]', !csv.includes('[object Object]'), csv)
check('raw beats the vnode for export', lines[1].endsWith(',7'), lines[1])

/* --- price helpers --------------------------------------------------------------------- */
const offer = { promo_off: 50, in: 200, out: 400, promo_in: 100, mine: null }
check('promo price wins for the net figure', ui.netPrice(offer, 'in') === 100, ui.netPrice(offer, 'in'))
check('list price when no promo', ui.netPrice({ promo_off: 0, in: 200 }, 'in') === 200)
check('missing price stays null', ui.netPrice({ in: null }, 'in') === null)
check('effective price needs both sides', ui.effectivePrice({ mine: { dong: 10, tok_billed: 0 } }) === null)
check('effective price is per 1M billed tokens', ui.effectivePrice({ mine: { dong: 10, tok_billed: 1000 } }) === 10000)
check('no change is a dash', ui.priceDelta({}) === '—')
check('new offer reads as just listed', ui.priceDelta({ chg: [{ kind: 'new' }] }) === 'just listed')
check('delisted reads as delisted', ui.priceDelta({ chg: [{ kind: 'gone' }] }) === 'delisted')
/* The field name is the machine value the price watch recorded (usage_store.py), so the English message
 * carries it through rather than inventing a translation the store never wrote. */
check('a price move names the field', ui.priceDelta({ chg: [{ kind: 'price', field: 'vào', pct: -52.4 }] }) === '-52% vào',
  ui.priceDelta({ chg: [{ kind: 'price', field: 'vào', pct: -52.4 }] }))
check('a rise carries the plus', ui.priceDelta({ chg: [{ kind: 'price', field: 'ra', pct: 8.9 }] }) === '+9% ra')

/* --- paging --------------------------------------------------------------------------- */
check('one page lists one page', ui.pageList(1, 1).join() === '1')
check('first page window is bounded below', ui.pageList(1, 400).join() === '1,2,3,400')
check('last page window is bounded above', ui.pageList(400, 400).join() === '1,398,399,400')
check('middle page shows five neighbours', ui.pageList(50, 400).join() === '1,48,49,50,51,52,400')

/* --- column contracts (the export and the screen must agree) --------------------------- */
/* The five column lists are factories: their labels have to be built after setLang, so a frozen English
 * array can never be shown to a reader whose language says otherwise. This gate calls them. */
for (const [name, columns] of Object.entries({
  MODELS: ui.MODEL_COLS(), SESSIONS: ui.SESSION_COLS(), LOG_MODELS: ui.LOG_MODEL_COLS(),
  KEYS: ui.KEY_COLS(), PROVIDERS: ui.PROVIDER_COLS()
})) {
  const sample = name === 'MODELS'
    ? { id: 'm', provider: 'p', provider_name: 'P', kind: 'text', context: 1000, in: 200, out: 300,
        cache_read: 100, floor: 5, success_rate: 99, mine: { calls: 10, dong: 2000, tok_billed: 100 },
        url: 'https://vilao.ai/model/p/m', chg: null }
    : name === 'SESSIONS' ? { session_id: 's', profile: 'p', platform: 'cli', calls: 1, models: 1,
        tokens: 10, tok_cache: 5, dong: 1, errors: 0, first_ts: 1, last_ts: 2 }
      : name === 'LOG_MODELS' ? { model_key: 'k', providers: 'p', profiles: 'h', calls: 1, tokens: 10,
          tok_cache: 5, dong: 1, usd: 0.01, errors: 0, avg_ms: 10, days: 1, last_ts: 2 }
        : name === 'KEYS' ? { name: 'k', key_prefix: 'sk', active: true, rate_limit_rpm: 60,
            total_requests: 5, subscriptions: 2, _dong24: 100, total_spent: 900 }
          : { provider: 'p', calls: 1, tokens: 2, dong: 3, rpm_now: 1, peak_rpm: 2, peak_rph: 3,
              errors: 0, last_ts: 1 }
  const missing = columns.filter(c => !c.sort).map(c => c.label)
  check(name + ': every column can be sorted', missing.length === 0, missing)
  const bad = columns.filter(c => {
    const v = c.sort(sample)
    return !(typeof v === 'number' || typeof v === 'string') || Number.isNaN(v)
  }).map(c => c.label)
  check(name + ': sort accessors return a comparable value', bad.length === 0, bad)
  const leaks = columns.filter(c => String(ui.cellValue(c, sample)).includes('[object Object]')).map(c => c.label)
  check(name + ': exported cell never leaks a vnode', leaks.length === 0, leaks)
  const untyped = columns.filter(c => {
    const v = ui.cellValue(c, sample)
    return !(typeof v === 'string' || typeof v === 'number')
  }).map(c => c.label)
  check(name + ': exported cell is text or a number', untyped.length === 0, untyped)
}

/* --- money (Task 8: one printer, one unit decision, no invented rate) -------------------------- */
/* Intl puts a no-break space between a Vietnamese amount and its symbol, which is invisible in a log and
 * a nightmare in a string comparison, so the assertions compare a flattened copy. What matters here is
 * the grouping, the symbol and the dash -- not which space ICU chose. */
const flat = s => String(s).replace(/[\u00A0\u202F\u2009]/g, ' ')
check('dong is grouped the way the account writes it',
  flat(ui.formatMoney(500000, { currency: 'auto' })) === '500.000 ₫',
  flat(ui.formatMoney(500000, { currency: 'auto' })))
check('dollars are grouped the way dollars are',
  flat(ui.formatMoney(500000, { currency: 'usd', rate: 25000 })) === '$20.00',
  flat(ui.formatMoney(500000, { currency: 'usd', rate: 25000 })))
check('the unit decides the grouping, not the language of the copy',
  flat(ui.dong(14820.5)) === '14.821 ₫', flat(ui.dong(14820.5)))
check('a crossing with no rate prints a dash, never a made-up figure',
  ui.formatMoney(500000, { currency: 'usd' }) === '—')
check('an estimate has no dong without a rate either', ui.est(0.02) === '—', ui.est(0.02))
check('a figure already in the unit asked for needs no rate',
  flat(ui.formatMoney(0.0042, { currency: 'usd', from: 'usd', digits: 4 })) === '$0.0042')
check('nothing to print is a dash', ui.formatMoney(null, { currency: 'vnd' }) === '—')
check('a non-number is a dash', ui.formatMoney('abc', { currency: 'vnd' }) === '—')

/* --- the locale actually reaches the widgets (Task 7's render pass is the other half) ---------- */
/* The column lists and the option lists are factories for exactly this reason: a const would have frozen
 * English labels in at import and the Vietnamese render would have shown English headers. */
ui.setLang('vi')
const viCols = ui.PROVIDER_COLS()
check('a column list built under vi carries vi labels', viCols.some(c => c.label === 'đỉnh rpm'),
  viCols.map(c => c.label))
check('a column list built under vi carries no en label', !viCols.some(c => c.label === 'peak rpm'))
const viRanges = ui.LOCALE_VI.live.range
check('the vi range list is the vi wording', viRanges.d30 === '30 ngày', viRanges)
ui.setLang('en')
check('switching back re-reads the en bundle', ui.PROVIDER_COLS().some(c => c.label === 'peak rpm'))

/* --- the external-link guard, re-checked here because it is a security boundary --------- */
check('https vilao link passes', ui.safeExternal('https://vilao.ai/model/dogi/glm-5.3') === 'https://vilao.ai/model/dogi/glm-5.3')
check('http is refused', ui.safeExternal('http://vilao.ai/x') === null)
check('other host is refused', ui.safeExternal('https://evil.test/model') === null)
check('javascript: is refused', ui.safeExternal('javascript:alert(1)') === null)
check('a vilao-looking host with a different authority is refused',
  ui.safeExternal('https://vilao.ai.evil.test/model') === null)

console.log(fails ? '\nUI UNITS FAILED: ' + fails : '\nUI UNITS OK')
process.exit(fails ? 1 : 0)
