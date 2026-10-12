/**
 * Usage: per-model call log and cost charts for Hermes Desktop.
 *
 * The page keeps the identity of the plugin it replaced (install slot, nav entry, palette command,
 * keybind) and replaces everything that used to live in it. Rows come from the
 * plugin's own backend (`/api/plugins/call-ledger/`), which stores one row per model call from two
 * feeds: Hermes' observer hooks (every provider, USD estimate) and vilao's billing API (real dong).
 * A new call arrives by event, not by polling; aggregates refresh every 5 minutes.
 *
 * House rules inherited from the previous page: no polling faster than 5 minutes, no cookies and no
 * credential CLIs. Colour comes from the app's own CSS tokens with a neutral fallback, which is why
 * the filter widgets are hand-built instead of native: a native dropdown paints its popup with the
 * OS palette, and on a dark skin that arrived as a white box carrying the page's light text.
 */

import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

/* Must equal the agent-side plugin.yaml name: ctx.rest addresses /api/plugins/<this id>/ and the
 * dashboard drops any dashboard manifest whose name is not a known agent plugin (spoof guard), so a
 * mismatched id 404s the whole page. */
const PLUGIN_ID = 'hermes-call-ledger'
const PLUGIN_NAME = 'Call Ledger'
const ROUTE = '/call-ledger'
const VERSION = '1.0.0'
const POLL_MS = 5 * 60 * 1000
const TABS = ['live', 'trend', 'log', 'quota', 'wallet', 'keys', 'models']

/* Plugin-scoped messages, kept in this file because the Desktop loader evaluates plugin.js as a blob and
 * refuses any import specifier outside @hermes/plugin-sdk / react (runtime-loader.ts unsupportedImports).
 * ctx.i18n.register below is what makes `auto` follow `display.language`; the explicit override exists
 * because the app cannot select Vietnamese today — see docs/specs §6.1. Resolution mirrors the SDK's:
 * chosen locale -> this plugin's own en -> the key itself. */

/* The two bundles. A key is dot-addressed (`t('tab.live')`) and a value is either a string or a function
 * that takes the arguments its sentence interpolates, so no call site ever builds a phrase with `+`.
 * tools/no_literal.mjs counts Vietnamese characters in the page code and skips everything between
 * BUNDLE-START and BUNDLE-END, because the bundles are where the copy is meant to live and Task 7 fills
 * LOCALE_VI with Vietnamese. */
/* BUNDLE-START */
const LOCALE_EN = {
  app: { title: 'Call ledger', version: v => 'v' + v, keys: 'keys: [ ] page · / filter · 1-7 tab · Esc close' },
  tab: { live: 'Live', trend: 'Trend', log: 'Log', quota: 'Quota', wallet: 'Wallet',
    keys: 'Keys', models: 'Models' },
  common: {
    none: 'No rows.', exporting: 'CSV', sortBy: label => 'sort by ' + label,
    loading: 'reading…', emptyDays: 'No days in this window yet.',
    exportRows: n => 'export the ' + n + ' rows shown to a CSV file',
    colsShown: n => 'columns · ' + n,
    colsTitle: 'choose which columns to show (kept for next time)'
  },
  sync: {
    error: e => 'error: ' + e,
    /* The walk tells you how deep it has got, because a half-read bill looks exactly like an empty one. */
    scanning: (days, page, read) => 'scanning the vilao bill ' + days + ' days back… page ' + page
      + ' · ' + read + ' rows read',
    done: (read, stored, matched) => 'sync: ' + read + ' rows read, ' + stored + ' new, ' + matched + ' matched'
  },
  live: {
    filterModel: 'filter model',
    pager: (page, pages, matched, per) => 'page ' + page + '/' + pages + ' · ' + matched
      + ' rows match · ' + per + '/page',
    prev: '‹ prev', next: 'next ›',
    modeHermes: 'Hermes calls', modeVilao: 'Vilao bill',
    pickKey: 'key', pickProvider: 'provider', pickHome: 'home', pickRange: 'time range',
    pickOutcome: 'result',
    mainOnly: 'main calls only',
    providerAll: 'every provider',
    dayChip: d => 'day ' + d,
    dayChipTitle: 'one day is selected, so the time range does not apply — click to clear it',
    syncPulse: 'Sync the bill',
    syncPulseTitle: 'Read further into the bill, stopping at the first page the store already holds.',
    syncRestart: 'Rescan 30 days',
    syncRestartTitle: 'Re-read 30 days of bill: add the new rows, pair them with the Hermes log and fill in '
      + 'the API key on rows ingested before the bill carried one.',
    homeAll: 'every home',
    homeBill: 'bill · no home',
    homeBillTitle: 'Rows vilao charged that the Hermes log has no matching call for — a charge belongs to '
      + 'the account, not to any one home.',
    homeMeta: (calls, dong) => calls + ' calls · ' + dong,
    keyStopped: spent => 'stopped · ' + spent,
    keyMeta: (prefix, requests) => prefix + ' · ' + requests + ' calls',
    keyUnlisted: 'no longer listed',
    billNote: matched => 'The vilao bill is read with the PAT; the filters apply to the ' + matched
      + ' matching rows of what has been pulled to this machine.',
    billEmpty: 'Nothing from the bill matches these filters within what has been pulled to this machine. '
      + 'Use Rescan 30 days to read deeper.',
    readFail: e => 'Could not read the log: ' + e,
    emptyStore: 'No calls in the store yet. This tab scans the vilao bill backwards on open, and the local '
      + 'log fills as you run the agent.',
    range: { all: 'all time', h24: '24 hours', d7: '7 days', d30: '30 days' },
    outcome: { all: 'any outcome', ok: 'success', error: 'error' },
    keyAll: 'every key',
    keyUnknown: 'no key named',
    /* One call row: the home cell, the model cell and the money cell each carry a small phrase. */
    rowHomeBill: 'bill',
    rowHomeTitle: 'A vilao bill row — an account-level charge the Hermes log has no matching call for, '
      + 'so no home made it.',
    rowModelTitle: 'show only this model',
    rowError: 'error',
    cacheShare: p => 'cache = ' + p + ' of the tokens',
    estTag: 'est',
    totalsLabel: 'this page',
    totalsRows: (n, per) => n + '/' + per + ' rows',
    totalsHomes: n => n + ' homes',
    totalsMatched: n => 'filters matched ' + n + ' rows',
    totalsCache: p => p + ' cache',
    /* Which of the two feeds a row came from, named the way the row itself can be checked. */
    match: { matched: 'matched in both feeds', localOnly: 'Hermes log only',
      billOnly: 'vilao bill only' },
    /* The Live log header: one entry per column of LOG_CELLS, in that order. */
    col: { clock: 'clock', date: 'date', home: 'home', model: 'model', keyProvider: 'key / provider',
      inOut: 'in → out', cache: 'cache', tokens: 'total tokens', delay: 'delay', dong: 'dong' }
  },
  trend: {
    yearGrid: n => 'Year ' + n + ' · Jan→Dec, each square is one day, shaded by billed dong',
    days: n => n + ' days',
    statCalls: 'Calls', statTokens: 'Tokens', statBilled: 'Billed by the invoice',
    statEstimate: 'Hermes estimate', statAvgDay: 'Average per day',
    tokenHint: (tokIn, tokOut, tokCache) => 'in ' + tokIn + ' · out ' + tokOut + ' · cache ' + tokCache,
    billedHint: 'the money actually taken off the wallet',
    estHint: 'Hermes own price list, converted to dong',
    avgHint: month => '≈ ' + month + '/month',
    noSpend: 'no spend yet',
    emptyBill: 'No day in this window matched a bill line.',
    burnLine: (perDay, days) => 'Spending ' + perDay + ' a day across the ' + days
      + ' most recent days with activity.',
    dailyTitle: days => 'Usage per day · last ' + days + ' days',
    seriesBilled: 'dong taken off', seriesTokens: 'tokens',
    dailyDongTitle: 'Dong per day (days with spend only)',
    latencyTitle: 'Average delay per day (ms)',
    deep: 'Scan 12 months', deepResume: 'Resume the 12-month scan',
    deepTitle: 'Read the vilao bill back over 12 months (~41,000 rows; it takes minutes).',
    deepResumeTitle: page => 'Continue from page ' + page + ', where the last run stopped. The store can '
      + 'only shade the days it already holds.'
  },
  quota: {
    window: { h1: '1 hour', h24: '24 hours', d7: '7 days' },
    col: { provider: 'provider', calls: 'calls', tokens: 'tokens', billed: 'dong billed',
      rpmNow: 'rpm now', peakRpm: 'peak rpm', peakRph: 'peak rph', errors: 'errors',
      last: 'last call' },
    note: 'measured from the Hermes log — these providers publish no usage API to read',
    readFail: e => 'Could not read the call rate: ' + e,
    statWindowCalls: 'Calls in the window', statTokens: 'Tokens', statPeakMinute: 'peak per minute',
    statPeakHour: 'peak per hour', statCharged: 'Charged',
    perMinute: v => v + '/min', perHour: v => v + '/hour',
    empty: 'No calls in this window yet.'
  },
  wallet: {
    col: { key: 'key', status: 'status', rpm: 'rpm', calls: 'calls', models: 'models',
      h24: '24 h', spent: 'spent' },
    state: { inUse: 'in use', revoked: 'revoked', stopped: 'stopped' },
    statLeft: 'Left', stat24h: 'Last 24 hours', statSpent: 'Spent (lifetime)',
    statDeposited: 'Total deposited (derived)', statWithdrawable: 'Withdrawable',
    ofDeposited: p => p + ' of everything deposited',
    perWeek: v => v + '/week', noSpend: 'no spend yet',
    readFail: e => 'Could not read the vilao wallet: ' + e,
    lowTitle: 'Running low',
    lowBody: left => left + ' left. Top up in the vilao app before your calls start failing.',
    pendingTitle: 'Top-ups waiting (the QR expires after 30 minutes)',
    pendingCol: { amount: 'amount', transaction: 'transaction id', expires: 'expires' },
    keysHeader: 'Your vilao API keys · the 24 h column comes from the synced call log',
    exportKeys: 'export every key shown',
    noKeys: 'This account has no API keys yet.',
    quotaNote: 'The reset windows this page reads are the per-key budgets and dates under Keys. The Quota '
      + 'tab measures request rate from these rows, because no billing route here publishes a provider '
      + 'quota window.',
    topupTitle: paid => 'Top-up history · total paid ' + paid,
    topupAccount: (name, about) => 'account ' + name + (about ? ' · ' + about : ''),
    topupRole: r => 'role ' + r,
    topupOpened: d => 'opened ' + d,
    topupActive: d => 'active ' + d,
    topupFail: 'Could not read the top-up history.',
    topupCol: { amount: 'amount', status: 'status', method: 'method', created: 'created',
      credited: 'credited to the wallet' },
    topupState: { paid: 'paid', pending: 'waiting' }
  },
  log: {
    window: { m1: '1 month', m3: '3 months', y1: '1 year' },
    statCalls: 'Calls', statTokens: 'Tokens', statModels: 'Models used', statCharged: 'Charged',
    statErrors: 'Errors',
    chargedHint: 'only the part the bill could be matched to',
    source: 'source: the Hermes log (every provider), not only the vilao bill',
    emptySessions: 'No sessions in this window yet.',
    emptyModels: 'No models in the log for this window yet.',
    dailyTitle: days => 'Usage per day · ' + days + ' days (Hermes log)',
    seriesTokens: 'tokens', seriesCalls: 'calls', seriesCache: 'tokens read from cache',
    byHomeTitle: 'Calls split by home',
    sessCol: {
      session: 'session', home: 'home', platform: 'platform', calls: 'calls', models: 'models',
      tokens: 'tokens', cache: 'cache', billed: 'dong billed', errors: 'errors', span: 'span',
      spanTitle: (from, to) => 'from ' + from + ' to ' + to
    },
    modelCol: {
      model: 'model', provider: 'provider', home: 'home', calls: 'calls', tokens: 'tokens',
      cache: 'cache', billed: 'dong billed', estimate: 'estimate', errors: 'errors',
      avgDelay: 'avg delay', days: 'days used', last: 'last seen',
      title: m => m + ' · click to see every call'
    }
  },
  keys: {
    statDayBudget: 'Daily budget', statMonthBudget: 'Monthly budget', notSet: 'not set',
    statCalls: 'Calls on this key', statPaid: 'This key has paid',
    resetIn: d => 'resets in ' + d,
    noResetDate: 'vilao answers with a reset date but not the spend inside the period',
    lifetimeHint: 'lifetime, per vilao',
    budgetNote: 'vilao returns the reset dates and none of what has been spent in the period, so the two '
      + 'budget cards are limits, not progress bars.',
    col: { key: 'key', status: 'status', rpm: 'rpm', models: 'models', totalCalls: 'total calls',
      totalPaid: 'total paid', since: 'opened', detail: 'detail' },
    readFail: 'Could not read the key list.',
    reload: 'Reload',
    noBook: 'This key has no price list of its own.',
    bookCol: { model: 'models this key can call', floor: 'floor per call', calls: 'calls',
      dong: 'dong', tokens: 'tokens', health: 'health' }
  },
  models: {
    selling: (offers, models, mine) => offers + ' offers on sale · ' + models + ' models · ' + mine
      + ' offers of a model you have paid for',
    search: 'find model / provider…',
    pickProvider: 'provider',
    providerAll: n => 'every provider (' + n + ')',
    offerMeta: n => n + ' offers',
    reading: 'reading the price list from vilao…',
    loading: 'reading the price list…',
    moved: n => 'price changes · ' + n,
    since: day => ' vs ' + day,
    watchFallback: 'the day before',
    refresh: 'Reload the price list',
    refreshTitle: 'The price list is a public page, cached 6 hours; click to read it again now.',
    readFail: 'Could not read the public price list from vilao. The page needs no token, so this is the '
      + 'connection or vilao itself answering, not anything about your account.',
    offerNote: 'Each row is one offer: several providers sell the same model at different prices, which is '
      + 'why this table is longer than the number of models.',
    exportOffers: n => 'export the ' + n + ' filtered offers (all of them, not just this page)',
    empty: 'No offer matches these filters.',
    noOffers: 'The price list came back with nothing on it. It is a public page and needs no token, so '
      + 'this is the fetch failing rather than your filters — reload it, or check that vilao.ai answers.',
    link: 'vilao ↗',
    price: {
      newListed: 'just listed', delisted: 'delisted',
      /* The watch records which price of an offer moved as a machine key; the label is the reader's, so
       * it is looked up here rather than printed from the payload. */
      move: (pct, field) => pct + ' ' + field
    },
    field: { in: 'input', out: 'output', cache: 'cache', floor: 'floor' },
    col: {
      model: 'model', provider: 'provider', kind: 'kind', context: 'context', priceIn: 'input price',
      priceOut: 'output price', cacheRead: 'cache read', floor: 'floor/call', success: 'success',
      callsMine: 'you called', paidMine: 'you paid', effective: 'dong/1M you paid',
      change: 'price change', open: 'open',
      latency: (ms, calls) => 'latency ' + ms + (calls ? ' · ' + calls + ' calls across the marketplace' : ''),
      billedOf: (bill, tokens) => 'billed ' + bill + ' / ' + tokens + ' tokens (cache read included)',
      noPriceData: 'not enough of your own traffic to work out a price',
      changeHead: 'against the price saved the day before',
      newOffer: 'offer newly published',
      goneOffer: 'offer no longer on the marketplace',
      changeLine: (field, from, to, pct) => field + ': ' + from + ' → ' + to + ' (' + pct + ')'
    }
  },
  money: {
    /* The unit and the grouping come from Intl.NumberFormat inside formatMoney, so no message here prints
     * a number: these say what the page did with a rate, and they are the only money copy left. */
    estTitle: (usd, rate) => 'Hermes estimate ' + usd + ' at ' + rate + ' per US dollar',
    rateLine: (usd, cny, source, stale) => '1 USD ≈ ' + usd + cny + ' · source ' + source
      + (stale ? ' (old price)' : ''),
    rateCny: cny => ' · 1 CNY ≈ ' + cny,
    noRate: 'No USD to dong rate yet, so the estimate columns print nothing rather than a made-up '
      + 'conversion.'
  },
  time: {
    days: n => n + ' days',
    daysHours: (d, h) => d + ' days ' + h + 'h',
    overdue: 'past due'
  },
  chart: {
    peak: v => 'peak ' + v,
    spanFrom: (n, from) => n + ' days · from ' + from,
    spanTo: (to, label, value) => 'to ' + to + ' · ' + label + ' ' + value
  },
  calendar: {
    mon: 'Mon', wed: 'Wed', fri: 'Fri',
    /* The month labels sit over 53 columns of 13px squares, so they are three letters, not twelve. */
    month: m => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1],
    yearLegend: (year, since, days) => 'Year ' + year + ' · the store holds bills from ' + since + ' · '
      + days + ' days with spend up to today · click a square to open that day in the log',
    noBill: 'No bill in the store yet.',
    less: 'less', more: 'more (dong/day)',
    callsTip: n => n + ' calls',
    openLog: 'click to see this day in the log',
    future: d => d + ' · still to come',
    noSpend: d => d + ' · no spend',
    beforeData: (d, since) => d + ' · earlier than the oldest bill data (' + since + ')'
  },
  detail: {
    title: 'Call detail', close: 'Close',
    time: 'Time', providerModel: 'Provider / model', vilaoKey: 'Vilao API key', apiMode: 'api_mode',
    session: 'Session', platform: 'Platform', kind: 'Kind', main: 'main', aux: 'auxiliary',
    tokensInOut: 'Tokens in/out', cacheReadWrite: 'Cache read/write', reasoning: 'Reasoning',
    delayTtft: 'Delay / TTFT', result: 'Result', error: 'error', context: 'Context',
    hermesEstimate: 'Hermes estimate', vilaoBill: 'Vilao bill', billMatch: 'Bill match'
  }
}
/* The Vietnamese bundle: the same tree as LOCALE_EN, key for key, with the wording the owner already
 * reads. Loanwords the Vietnamese UI borrows rather than invents (provider, model, cache, home, delay)
 * and machine field names (api_mode, health) stay as the platform writes them -- tests/locale_parity.test.mjs
 * carries that short list and fails on anything else that is still English prose. */
const LOCALE_VI = {
  app: { title: 'Sổ chi phí gọi', version: v => 'v' + v,
    keys: 'phím: [ ] trang · / lọc · 1-7 tab · Esc đóng' },
  tab: { live: 'Live', trend: 'Xu hướng', log: 'Log', quota: 'Hạn mức', wallet: 'Ví',
    keys: 'Key', models: 'Model' },
  common: {
    none: 'Không có dòng nào.', exporting: 'CSV', sortBy: label => 'sắp xếp theo ' + label,
    loading: 'đang đọc…', emptyDays: 'Chưa có ngày nào trong cửa sổ này.',
    exportRows: n => 'xuất ' + n + ' dòng đang hiển thị ra file CSV',
    colsShown: n => 'cột · ' + n,
    colsTitle: 'chọn cột muốn xem (lưu lại cho lần sau)'
  },
  sync: {
    error: e => 'Lỗi: ' + e,
    scanning: (days, page, read) => 'Đang quét hóa đơn vilao ' + days + ' ngày… trang ' + page
      + ' · ' + read + ' dòng đã đọc',
    done: (read, stored, matched) => 'Đồng bộ: ' + read + ' dòng đọc, ' + stored + ' mới, '
      + matched + ' khớp'
  },
  live: {
    filterModel: 'lọc model…',
    pager: (page, pages, matched, per) => 'trang ' + page + '/' + pages + ' · ' + matched
      + ' dòng khớp · ' + per + '/trang',
    prev: '‹ trước', next: 'sau ›',
    modeHermes: 'Hermes gọi', modeVilao: 'Hóa đơn Vilao',
    pickKey: 'key', pickProvider: 'provider', pickHome: 'home', pickRange: 'khung giờ',
    pickOutcome: 'kết quả',
    mainOnly: 'chỉ lượt gọi chính',
    providerAll: 'mọi provider',
    dayChip: d => 'ngày ' + d,
    dayChipTitle: 'đang lọc đúng một ngày nên khung giờ không áp dụng — bấm để bỏ',
    syncPulse: 'Đồng bộ hóa đơn',
    syncPulseTitle: 'Đọc thêm hóa đơn cho tới trang đầu tiên đã có sẵn trong store.',
    syncRestart: 'Quét lại 30 ngày',
    syncRestartTitle: 'Quét lại 30 ngày hóa đơn: nạp dòng mới, ghép cặp với log Hermes và điền API key '
      + 'cho những dòng được nạp trước khi hóa đơn có key.',
    homeAll: 'mọi home',
    homeBill: 'hóa đơn · không rõ home',
    homeBillTitle: 'Những dòng vilao tính tiền nhưng log Hermes không có lượt tương ứng — một khoản tính '
      + 'tiền thuộc về tài khoản, không thuộc về home nào cả.',
    homeMeta: (calls, dong) => calls + ' lượt · ' + dong,
    keyStopped: spent => 'ngưng · ' + spent,
    keyMeta: (prefix, requests) => prefix + ' · ' + requests + ' lượt',
    keyUnlisted: 'không còn liệt kê',
    billNote: matched => 'Hóa đơn vilao đọc bằng PAT; bộ lọc áp lên ' + matched
      + ' dòng khớp trong số đã cập nhật về máy.',
    billEmpty: 'Chưa có dòng hóa đơn nào khớp bộ lọc trong số đã cập nhật về máy. '
      + 'Bấm “Quét lại 30 ngày” để đọc sâu hơn.',
    readFail: e => 'Không đọc được log: ' + e,
    emptyStore: 'Chưa có lượt gọi nào trong store. Lần mở tab này sẽ quét ngược hóa đơn vilao, còn log '
      + 'tại máy đầy dần khi bạn chạy agent.',
    range: { all: 'toàn bộ', h24: '24 giờ', d7: '7 ngày', d30: '30 ngày' },
    outcome: { all: 'mọi kết quả', ok: 'thành công', error: 'lỗi' },
    keyAll: 'mọi key',
    keyUnknown: 'không rõ key',
    rowHomeBill: 'hóa đơn',
    rowHomeTitle: 'Dòng hóa đơn vilao — một khoản tính tiền của tài khoản, log Hermes không có lượt tương '
      + 'ứng nên không home nào gọi cả.',
    rowModelTitle: 'chỉ hiện model này',
    rowError: 'lỗi',
    cacheShare: p => 'cache = ' + p + ' của token',
    estTag: 'est',
    totalsLabel: 'tổng trang này',
    totalsRows: (n, per) => n + '/' + per + ' dòng',
    totalsHomes: n => n + ' home',
    totalsMatched: n => 'bộ lọc khớp ' + n + ' dòng',
    totalsCache: p => p + ' cache',
    match: { matched: 'đã ghép hai nguồn', localOnly: 'chỉ log Hermes',
      billOnly: 'chỉ hóa đơn vilao' },
    col: { clock: 'giờ', date: 'ngày', home: 'home', model: 'model', keyProvider: 'key / provider',
      inOut: 'vào → ra', cache: 'cache', tokens: 'tổng token', delay: 'delay', dong: '₫' }
  },
  trend: {
    yearGrid: n => 'Năm ' + n + ' · T1→T12, mỗi ô vuông là một ngày, đậm theo tiền đã bị trừ',
    days: n => n + ' ngày',
    statCalls: 'Lượt gọi', statTokens: 'Token', statBilled: 'Tiền theo hóa đơn',
    statEstimate: 'Hermes ước tính', statAvgDay: 'Trung bình/ngày',
    tokenHint: (tokIn, tokOut, tokCache) => 'vào ' + tokIn + ' · ra ' + tokOut + ' · cache ' + tokCache,
    billedHint: 'tiền thật đã trừ vào ví',
    estHint: 'bảng giá nội bộ, quy đổi ra đ',
    avgHint: month => '≈ ' + month + '/tháng',
    noSpend: 'chưa có chi tiêu',
    emptyBill: 'Chưa có dòng nào khớp hóa đơn trong cửa sổ này.',
    burnLine: (perDay, days) => 'Chi tiêu ' + perDay + '/ngày trong ' + days
      + ' ngày gần đây có hoạt động.',
    dailyTitle: days => 'Usage mỗi ngày · ' + days + ' ngày gần nhất',
    seriesBilled: 'tiền bị trừ (đ)', seriesTokens: 'token',
    dailyDongTitle: 'Tiền mỗi ngày (đ, chỉ ngày có chi tiêu)',
    latencyTitle: 'Độ trễ trung bình mỗi ngày (ms)',
    deep: 'Quét 12 tháng', deepResume: 'Quét tiếp 12 tháng',
    deepTitle: 'Đọc hóa đơn vilao ngược về 12 tháng (~41.000 dòng, tính bằng phút).',
    deepResumeTitle: page => 'Quét tiếp từ trang ' + page + ' (đang dở). Store chỉ tô được những ngày '
      + 'nó đang giữ.'
  },
  quota: {
    window: { h1: '1 giờ', h24: '24 giờ', d7: '7 ngày' },
    col: { provider: 'provider', calls: 'lượt', tokens: 'token', billed: '₫ hóa đơn',
      rpmNow: 'rpm bây giờ', peakRpm: 'đỉnh rpm', peakRph: 'đỉnh rph', errors: 'lỗi',
      last: 'gần nhất' },
    note: 'đo từ log Hermes — các provider này không có API usage để đọc',
    readFail: e => 'Không đọc được nhịp gọi: ' + e,
    statWindowCalls: 'Lượt trong cửa sổ', statTokens: 'Token', statPeakMinute: 'đỉnh mỗi phút',
    statPeakHour: 'đỉnh mỗi giờ', statCharged: 'Bị trừ tiền',
    perMinute: v => v + '/phút', perHour: v => v + '/giờ',
    empty: 'Chưa có lượt gọi nào trong cửa sổ này.'
  },
  wallet: {
    col: { key: 'key', status: 'trạng thái', rpm: 'rpm', calls: 'lượt gọi', models: 'model',
      h24: '24 h', spent: 'đã tiêu' },
    state: { inUse: 'đang dùng', revoked: 'đã thu hồi', stopped: 'ngưng' },
    statLeft: 'Còn lại', stat24h: '24 giờ qua', statSpent: 'Đã tiêu (cả đời)',
    statDeposited: 'Tổng đã nạp (suy ra)', statWithdrawable: 'Rút được',
    ofDeposited: p => p + ' của tổng đã nạp',
    perWeek: v => v + '/tuần', noSpend: 'chưa có chi tiêu',
    readFail: e => 'Không đọc được ví vilao: ' + e,
    lowTitle: 'Sắp hết tiền',
    lowBody: left => 'Còn ' + left + '. Nạp thêm trong app vilao trước khi các lượt gọi fail.',
    pendingTitle: 'Lệnh nạp đang chờ (QR hết hạn sau 30 phút)',
    pendingCol: { amount: 'số tiền', transaction: 'mã giao dịch', expires: 'hết hạn' },
    keysHeader: 'API key của bạn trên vilao · cột “24 h” lấy từ log cuộc gọi đã sync',
    exportKeys: 'xuất toàn bộ key đang hiển thị',
    noKeys: 'Chưa có API key nào trên tài khoản.',
    quotaNote: 'Cửa sổ reset mà trang này đọc được là ngân sách và mốc reset theo từng key, xem ở tab Key. '
      + 'Tab Hạn mức đo nhịp gọi từ chính các dòng này, vì không có route tính phí nào ở đây công bố cửa '
      + 'sổ quota của provider.',
    topupTitle: paid => 'Lịch sử nạp tiền · tổng đã trả ' + paid,
    topupAccount: (name, about) => 'tài khoản ' + name + (about ? ' · ' + about : ''),
    topupRole: r => 'vai ' + r,
    topupOpened: d => 'mở ' + d,
    topupActive: d => 'hoạt động ' + d,
    topupFail: 'Không đọc được lịch sử nạp.',
    topupCol: { amount: 'số tiền', status: 'trạng thái', method: 'hình thức', created: 'lúc tạo',
      credited: 'tiền về ví' },
    topupState: { paid: 'đã trả', pending: 'đang chờ' }
  },
  log: {
    window: { m1: '1 tháng', m3: '3 tháng', y1: '1 năm' },
    statCalls: 'Lượt gọi', statTokens: 'Token', statModels: 'Model đã dùng', statCharged: 'Bị trừ tiền',
    statErrors: 'Lỗi',
    chargedHint: 'chỉ phần khớp được hóa đơn',
    source: 'nguồn: log Hermes (mọi provider), không chỉ hóa đơn vilao',
    emptySessions: 'Chưa có phiên nào trong cửa sổ này.',
    emptyModels: 'Chưa có model nào trong log ở cửa sổ này.',
    dailyTitle: days => 'Usage mỗi ngày · ' + days + ' ngày (log Hermes)',
    seriesTokens: 'token', seriesCalls: 'lượt gọi', seriesCache: 'token đọc từ cache',
    byHomeTitle: 'Lượt gọi chia theo home',
    sessCol: {
      session: 'phiên', home: 'home', platform: 'nền', calls: 'lượt', models: 'model',
      tokens: 'token', cache: 'cache', billed: '₫ hóa đơn', errors: 'lỗi', span: 'dài',
      spanTitle: (from, to) => 'từ ' + from + ' tới ' + to
    },
    modelCol: {
      model: 'model', provider: 'provider', home: 'home', calls: 'lượt', tokens: 'token',
      cache: 'cache', billed: '₫ hóa đơn', estimate: 'ước tính', errors: 'lỗi',
      avgDelay: 'trễ TB', days: 'ngày dùng', last: 'lần cuối',
      title: m => m + ' · bấm để xem từng lượt gọi'
    }
  },
  keys: {
    statDayBudget: 'Ngân sách ngày', statMonthBudget: 'Ngân sách tháng', notSet: 'không đặt',
    statCalls: 'Lượt của key', statPaid: 'Key này đã trả',
    resetIn: d => 'reset sau ' + d,
    noResetDate: 'vilao không trả lời ngày reset',
    lifetimeHint: 'cả đời, theo vilao',
    budgetNote: 'vilao trả về ngày reset nhưng không trả về số đã tiêu trong kỳ — hai ô ngân sách là hạn '
      + 'mức, không phải thanh tiến trình.',
    col: { key: 'key', status: 'trạng thái', rpm: 'rpm', models: 'model', totalCalls: 'tổng lượt',
      totalPaid: 'tổng đã trả', since: 'mở từ', detail: 'chi tiết' },
    readFail: 'Không đọc được danh sách key.',
    reload: 'Đọc lại',
    noBook: 'Key này không có bảng giá riêng.',
    bookCol: { model: 'model key này gọi được', floor: 'sàn mỗi lượt', calls: 'lượt',
      dong: '₫', tokens: 'token', health: 'health' }
  },
  models: {
    selling: (offers, models, mine) => offers + ' offer đang bán · ' + models + ' model · ' + mine
      + ' offer có model bạn từng trả tiền',
    search: 'tìm model / provider…',
    pickProvider: 'provider',
    providerAll: n => 'mọi provider (' + n + ')',
    offerMeta: n => n + ' offer',
    reading: 'đang đọc bảng giá từ vilao…',
    loading: 'đang đọc bảng giá…',
    moved: n => 'đổi giá · ' + n,
    since: day => ' so với ' + day,
    watchFallback: 'hôm trước',
    refresh: 'Đọc lại bảng giá',
    refreshTitle: 'Bảng giá là trang công khai, cache 6 giờ; bấm để đọc lại ngay.',
    readFail: 'Không đọc được bảng giá công khai từ vilao. Trang này không cần token, nên lỗi nằm ở kết '
      + 'nối hoặc phía vilao trả lời — không phải ở tài khoản của bạn.',
    offerNote: 'Mỗi dòng là một offer: cùng một model có nhiều provider bán với giá khác nhau, đó là lý do '
      + 'bảng này dài hơn số model.',
    exportOffers: n => 'xuất ' + n + ' offer đang lọc (toàn bộ, không chỉ trang này)',
    empty: 'Không offer nào khớp bộ lọc.',
    noOffers: 'Bảng giá trả về không có offer nào. Đây là trang công khai và không cần token, nên lỗi ở '
      + 'lần đọc trang chứ không phải bộ lọc của bạn — đọc lại, hoặc kiểm tra vilao.ai có trả lời không.',
    link: 'vilao ↗',
    price: {
      newListed: 'mới bán', delisted: 'ngừng bán',
      move: (pct, field) => pct + ' ' + field
    },
    field: { in: 'vào', out: 'ra', cache: 'cache', floor: 'sàn' },
    col: {
      model: 'model', provider: 'provider', kind: 'loại', context: 'ngữ cảnh', priceIn: 'giá vào',
      priceOut: 'giá ra', cacheRead: 'cache đọc', floor: 'sàn/lượt', success: 'thành công',
      callsMine: 'bạn đã gọi', paidMine: 'bạn đã trả', effective: 'đ/1M bạn trả',
      change: 'đổi giá', open: 'mở',
      latency: (ms, calls) => 'độ trễ ' + ms + (calls ? ' · ' + calls + ' lượt toàn marketplace' : ''),
      billedOf: (bill, tokens) => 'hóa đơn ' + bill + ' / ' + tokens + ' token (gồm cache đọc)',
      noPriceData: 'chưa đủ dữ liệu để suy ra giá',
      changeHead: 'so với giá đã lưu ngày trước',
      newOffer: 'offer mới xuất bản',
      goneOffer: 'offer không còn trên marketplace',
      changeLine: (field, from, to, pct) => field + ': ' + from + ' → ' + to + ' (' + pct + ')'
    }
  },
  money: {
    estTitle: (usd, rate) => 'Hermes ước tính ' + usd + ' theo ' + rate + ' mỗi đô la Mỹ',
    rateLine: (usd, cny, source, stale) => '1 USD ≈ ' + usd + cny + ' · nguồn ' + source
      + (stale ? ' (giá cũ)' : ''),
    rateCny: cny => ' · 1 CNY ≈ ' + cny,
    noRate: 'Chưa lấy được tỷ giá USD→đ, nên cột ước tính in dấu — thay vì một con số tự bịa.'
  },
  time: {
    days: n => n + ' ngày',
    daysHours: (d, h) => d + ' ngày ' + h + 'h',
    overdue: 'đã quá hạn'
  },
  chart: {
    peak: v => 'đỉnh ' + v,
    spanFrom: (n, from) => n + ' ngày · từ ' + from,
    spanTo: (to, label, value) => 'tới ' + to + ' · ' + label + ' ' + value
  },
  calendar: {
    mon: 'T2', wed: 'T4', fri: 'T6',
    month: m => 'T' + m,
    yearLegend: (year, since, days) => 'Năm ' + year + ' (T1→T12) · store giữ hóa đơn từ ' + since
      + ' · ' + days + ' ngày có chi tiêu tới hôm nay · bấm một ô để xem log ngày đó',
    noBill: 'Chưa có hóa đơn trong store.',
    less: 'ít', more: 'nhiều (đ/ngày)',
    callsTip: n => n + ' lượt',
    openLog: 'bấm để xem log ngày này',
    future: d => d + ' · chưa tới',
    noSpend: d => d + ' · không chi tiêu',
    beforeData: (d, since) => d + ' · sớm hơn dữ liệu hóa đơn sớm nhất (' + since + ')'
  },
  detail: {
    title: 'Chi tiết lượt gọi', close: 'Đóng',
    time: 'Thời điểm', providerModel: 'Provider / model', vilaoKey: 'Vilao API key', apiMode: 'api_mode',
    session: 'Session', platform: 'Nền tảng', kind: 'Loại', main: 'chính', aux: 'phụ trợ',
    tokensInOut: 'Tokens vào/ra', cacheReadWrite: 'Cache đọc/ghi', reasoning: 'Reasoning',
    delayTtft: 'Độ trễ / TTFT', result: 'Kết quả', error: 'lỗi', context: 'Context',
    hermesEstimate: 'Hermes ước tính', vilaoBill: 'Vilao hóa đơn', billMatch: 'Khớp hóa đơn'
  }
}
/* BUNDLE-END */

const BUNDLES = { en: LOCALE_EN, vi: LOCALE_VI }
let current = 'en'

/* `auto` keeps the app's own locale; only 'en' and 'vi' override it, because those are the two bundles
 * this plugin ships. Anything else -- a typo, a language the plugin has no strings for -- falls through
 * to the app locale rather than blanking the page. */
function resolve(appLocale, setting) {
  const s = String(setting || '').trim().toLowerCase()
  return (s === 'en' || s === 'vi') ? s : (appLocale || 'en')
}

/* Not `export`ed: the loader reads only the default export, and tests reach these helpers through the
 * export line tests/render_plugin.mjs appends to its copy. A real `export` here would collide with that
 * line and make the generated module fail to parse. */
function setLang(l) { current = l }
function lang() { return current }

function dig(bundle, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), bundle)
}

function t(key, ...args) {
  const v = dig(BUNDLES[current], key) ?? dig(BUNDLES.en, key)
  if (v == null) return key
  return typeof v === 'function' ? v(...args) : String(v)
}

/* Read as a function, not a const: the labels come from the bundle, so they have to be produced after
 * setLang, not when the module is evaluated. */
const TAB_LABEL = () => Object.fromEntries(TABS.map(k => [k, t('tab.' + k)]))

const host = sdk.host
const { useValue, atom, useQuery, queryClient, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, KEYBINDS_AREA } = sdk

let rest = null
let onEvent = typeof host.onEvent === 'function' ? host.onEvent.bind(host) : null
/* The SDK's OS door (apps/desktop/src/contrib/plugin.ts:64), captured at register() like `rest` is. It is
 * the attributed way a plugin asks the machine to open a link; `window.hermesDesktop` is the app's own
 * bridge, which a listed plugin may not use (catalog rule 8: the SDK surface only). Null on a host that
 * exposes no such door, which is the one case the fallback below is for. */
let osOpen = null

const $tab = atom('live')
const $error = atom(null)
const $sync = atom(null)
const $mode = atom('hermes')      /* 'hermes' = every call Hermes logged | 'vilao' = the vilao bill */
const $provider = atom('')
const $key = atom('')             /* vilao consumer_key_id, '' = every key */
const $range = atom('')           /* hours, '' = the whole store */
const $outcome = atom('')         /* '' | 'ok' | 'error' */
const $search = atom('')
const $mainOnly = atom(false)
const $profile = atom('')          /* '' = every home; '-' = bill rows with no home */
const $page = atom(1)              /* page of the log table; changing a filter goes back to page 1 */
const $modelsPage = atom(1)        /* page of the offer table -- so [ ] pages whichever tab is open */
const $day = atom('')              /* '' = every day; one specific day when a calendar square is clicked */
const $openRow = atom(null)

/* The store is paged because it holds every call the install has made and the page used to read 400
 * and call that the whole picture. */
const PER_PAGE = 100
/* A billing row carries no home: a charge belongs to the account and to the API key it was billed to.
 * The backend reads this exact value back as "the unattributed ones". */
const NO_HOME = '-'

/* ---------- formatting ---------- */

/* The two units this page can print, each with the writing system that unit uses: dong groups with a
 * dot and puts the symbol after the amount (500.000 ₫, the way the account itself writes it), dollars
 * group with a comma and lead with the sign ($0.02). The unit decides the grouping, not the language of
 * the surrounding copy -- an English reader of a dong bill still reads the bill's number, and a
 * Vietnamese reader of a dollar estimate reads dollars. */
const MONEY_UNIT = { vnd: { tag: 'vi-VN', code: 'VND', digits: 0 }, usd: { tag: 'en-US', code: 'USD', digits: 2 } }

/* Page writes this once per render, before any child draws: which unit the reader asked for, and the
 * backend's current rate for crossing between the two. `rate` is null until /fx answers. */
let MONEY = { currency: 'auto', rate: null }

/* The page's only money printer. `value` is in `from` -- dong for a billed figure, dollars for one of
 * Hermes' estimates -- and comes out in the unit the reader chose, `auto` being the account's own dong.
 *
 * Crossing between the two units is the one thing this cannot do without the backend's rate, and it does
 * not pretend to: no rate is `—`. The page used to convert at a bootstrap number copied from fx.py, which
 * printed a dong figure the account was never charged and labelled it an estimate (spec §6.1). */
function formatMoney(value, { currency = MONEY.currency, from = 'vnd', rate = MONEY.rate, digits } = {}) {
  const n = Number(value)
  if (value == null || value === '' || !isFinite(n)) return '—'
  /* `auto` is the account's own unit, dong. A value the schema does not know (config.yaml is
   * hand-editable and the host only warns about it) also prints dong, rather than throwing away every
   * money column on the page. */
  const wanted = currency === 'auto' ? 'vnd' : currency
  const to = MONEY_UNIT[wanted] ? wanted : 'vnd'
  let amount = n
  if (from !== to) {
    if (!rate) return '—'
    amount = from === 'usd' ? n * rate : n / rate
  }
  const unit = MONEY_UNIT[to]
  /* `digits` is for the one place a column cannot hold the figure: a call costs a fraction of a cent, so
   * the tooltip that names the estimate asks for four of them and the table that summarises it does not. */
  const places = digits == null ? unit.digits : digits
  return new Intl.NumberFormat(unit.tag, { style: 'currency', currency: unit.code,
    minimumFractionDigits: places, maximumFractionDigits: places }).format(amount)
}

const num = v => (Number(v) || 0).toLocaleString('en-US')
const pct = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1) + '%'

/* A billed figure, in the unit the reader chose. */
const dong = v => formatMoney(v, { from: 'vnd' })
/* An estimate is dollars until there is a rate to read it as dong, so a reader who asked for dong and got
 * no rate sees a dash rather than a number nobody charged. */
const est = v => (v == null || v === '') ? '—' : formatMoney(v, { from: 'usd' })
const estTitle = v => (v == null || !MONEY.rate) ? '' : t('money.estTitle',
  formatMoney(v, { currency: 'usd', from: 'usd', digits: 4 }), formatMoney(MONEY.rate, { currency: 'vnd' }))

/* vi-VN writes the time FIRST and the date last ("21:48:49 8/10/2026"), so slicing the tail of the
 * combined locale string returns the date, not the clock -- which is the bug this replaces. Each part
 * is formatted on its own, with an explicit 24-hour cycle rather than hour12, because hour12 is only a
 * preference and some ICU builds still answer with CH/SA. */
const CLOCK = new Intl.DateTimeFormat('vi-VN',
  { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const DATE = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
const LONG = new Intl.DateTimeFormat('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit',
  year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const dateOf = ts => ts ? DATE.format(new Date(Number(ts) * 1000)) : '—'
const clockOf = ts => ts ? CLOCK.format(new Date(Number(ts) * 1000)) : '—'
const longOf = ts => ts ? LONG.format(new Date(Number(ts) * 1000)) : '—'

/* Token counts are read as magnitude, not digits: 20000 is a wall of text, 20,0k is a number. */
/* Tokens are read as magnitude: 25250 is a wall of digits, 25,3k is a number you can compare. */
const tok = v => {
  const n = Number(v) || 0
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace('.', ',') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace('.', ',') + 'k'
  return String(Math.round(n))
}

function shortModel(model) {
  const parts = String(model || '?').split('/')
  return parts.length > 1 ? parts.slice(-2).join('/') : parts[0]
}

/* A session id is a uuid; the first block is the only part a human can compare by eye, and the tooltip
   carries the whole thing. */
const shortSession = id => String(id || '?').slice(0, 8)

/* How long a session ran, in the unit that fits. Same-day spans are the common case, so hours and
   minutes carry the detail rather than a bare "0 days". */
function spanOf(first, last) {
  const secs = Math.max(0, Number(last) - Number(first))
  if (!secs) return '—'
  if (secs < 60) return Math.round(secs) + 's'
  if (secs < 3600) return Math.round(secs / 60) + 'p'
  if (secs < 86400) return (secs / 3600).toFixed(secs < 36000 ? 1 : 0).replace('.', ',') + 'h'
  return t('time.days', Math.round(secs / 86400))
}

const money = row => (row.bill_cost_vnd != null ? dong(row.bill_cost_vnd) : est(row.est_cost_usd))

/* ---------- data ---------- */

async function api(path, options) {
  if (!rest) throw new Error('plugin backend not mounted')
  return rest(path, options)
}

const CALLS_KEY = ['usage', 'calls']
const VILAO_KEY = ['usage', 'vilao']
const SUMMARY_KEY = ['usage', 'summary']
const BALANCE_KEY = ['usage', 'balance']
const KEYS_KEY = ['usage', 'keys']
const PROFILES_KEY = ['usage', 'profiles']
const RATE_KEY = ['usage', 'rate']
const CATALOG_KEY = ['usage', 'catalog']
const TOPUPS_KEY = ['usage', 'topups']
const DETAIL_KEY = ['usage', 'key-detail']
const LOG_KEY = ['usage', 'log']
const SESSIONS_KEY = ['usage', 'sessions']

const q = params => Object.entries(params)
  .filter(([, v]) => v !== '' && v != null)
  .map(([k, v]) => k + '=' + encodeURIComponent(v))
  .join('&')

/* Both log queries are one page of a paged table: the answer carries `total`/`pages`, so the pager knows
 * whether there is a next page instead of guessing from a short list. */
function useCalls(active) {
  const provider = useValue($provider)
  const search = useValue($search)
  const mainOnly = useValue($mainOnly)
  const range = useValue($range)
  const outcome = useValue($outcome)
  const profile = useValue($profile)
  const page = useValue($page)
  const day = useValue($day)
  return useQuery({
    queryKey: [...CALLS_KEY, provider, search, mainOnly, range, outcome, profile, page, day],
    queryFn: () => api('/calls?' + q({
      per: PER_PAGE, page, provider, model: search, outcome, hours: day ? '' : range, profile,
      day, main_only: mainOnly ? 1 : ''
    })),
    enabled: active,
    refetchInterval: active ? POLL_MS : false,
    staleTime: 20000
  })
}

/* The Vilao mode of the Live tab: the same store, restricted to rows vilao actually billed, and
 * refreshed by pulsing the bill endpoint (the backend rate-limits the pulse, not the read). */
function useVilaoCalls(active) {
  const search = useValue($search)
  const key = useValue($key)
  const range = useValue($range)
  const outcome = useValue($outcome)
  const profile = useValue($profile)
  const page = useValue($page)
  const day = useValue($day)
  return useQuery({
    queryKey: [...VILAO_KEY, key, search, range, outcome, profile, page, day],
    queryFn: () => api('/calls?' + q({
      per: PER_PAGE, page, billed: 1, pulse: 1, key_id: key, model: search, outcome,
      hours: day ? '' : range, profile, day
    })),
    enabled: active,
    refetchInterval: active ? POLL_MS : false,
    staleTime: 15000
  })
}

/* Which homes are contributing. Without this a profile that never called looks identical to one whose
 * plugin is switched off, and the second is a configuration problem, not a usage fact. */
function useProfiles() {
  return useQuery({ queryKey: PROFILES_KEY, queryFn: () => api('/profiles'), refetchInterval: POLL_MS, staleTime: 30000 })
}

function useRate(hours) {
  const profile = useValue($profile)
  return useQuery({
    queryKey: [...RATE_KEY, hours, profile],
    queryFn: () => api('/rate?' + q({ hours, profile })),
    refetchInterval: POLL_MS,
    staleTime: 20000
  })
}

function useCatalog(search) {
  return useQuery({
    queryKey: [...CATALOG_KEY, search],
    queryFn: () => api('/catalog?' + q({ q: search })),
    refetchInterval: 30 * POLL_MS,
    staleTime: 10 * 60 * 1000
  })
}

function useTopups() {
  return useQuery({ queryKey: TOPUPS_KEY, queryFn: () => api('/topups'), refetchInterval: 6 * POLL_MS, staleTime: 5 * 60 * 1000 })
}

function useKeyDetail(id) {
  return useQuery({
    queryKey: [...DETAIL_KEY, id],
    queryFn: () => api('/keys/detail?' + q({ key_id: id })),
    enabled: !!id,
    staleTime: 60000
  })
}

function useKeys(enabled) {
  return useQuery({
    queryKey: KEYS_KEY,
    queryFn: () => api('/keys'),
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    staleTime: 60000
  })
}

function keyName(map, id) {
  if (!id) return t('live.keyUnknown')
  const k = map && map[id]
  return k ? (k.name || k.key_prefix || id.slice(0, 8)) : id.slice(0, 8)
}

function useSummary(days, source) {
  const profile = useValue($profile)
  return useQuery({
    queryKey: [...SUMMARY_KEY, days, profile, source || ''],
    queryFn: () => api('/summary?' + q({ days, profile, source })),
    refetchInterval: POLL_MS,
    staleTime: 60000
  })
}

/* Per-model totals from the Hermes log itself. ``source=hook`` is the point: this is the view that covers
 * every provider Hermes can route to, and mixing in the billing feed would hide the free tiers behind
 * rows that only exist because vilao charged for something else. */
function useLog(days) {
  const profile = useValue($profile)
  return useQuery({
    queryKey: [...LOG_KEY, days, profile],
    queryFn: () => api('/log?' + q({ days, profile, source: 'hook' })),
    refetchInterval: POLL_MS,
    staleTime: 60000
  })
}

/* What one conversation cost. Only hook rows carry a session id, so this is a log view by construction. */
function useSessions(days) {
  const profile = useValue($profile)
  return useQuery({
    queryKey: [...SESSIONS_KEY, days, profile],
    queryFn: () => api('/sessions?' + q({ days, profile })),
    refetchInterval: POLL_MS,
    staleTime: 60000
  })
}

const FX_KEY = ['usage', 'fx']
/* The conversion table is read once and kept for the session: the backend holds the real cache (six
 * hours) in the acting home's own file, so a refetch here is a disk read, not another call to the feed.
 * Page writes the rate into MONEY during render (see the money printer above), so the formatters that
 * have no props to take it through still print the rate the backend answered with. */
function useFx() {
  return useQuery({
    queryKey: FX_KEY,
    queryFn: () => api('/fx'),
    staleTime: 30 * 60 * 1000,
    refetchInterval: 6 * POLL_MS
  })
}

const SETTINGS_KEY = ['call-ledger', 'settings']
/* The reader's three settings, once per minute at most: a settings change lands in config.yaml through
 * the Plugins hub, and a page that repaints its language on the next poll is a page that repaints
 * nothing until it is reloaded. The route answers with the manifest defaults when nothing is set, so this
 * query has no "not configured yet" branch for the page to invent. */
function useSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api('/settings'), staleTime: 60000 })
}

/* `useI18n` is the only sanctioned read of the app's own language (apps/desktop/src/sdk/index.ts). An
 * older or remote host that has no such export leaves appLocale undefined and `resolve` answers English,
 * which is the documented fallback -- the plugin never reaches into app stores for it. */
const useAppLocale = typeof sdk.useI18n === 'function' ? () => (sdk.useI18n() || {}).locale : () => undefined

/* A rate is a relationship between two units, so the dong side of the line is dong whatever the reader's
 * money setting says; converting it to dollars would print "1 USD ≈ $1" and call that information. */
const rateLine = fx => fx && fx.usd_vnd
  ? t('money.rateLine', formatMoney(fx.usd_vnd, { currency: 'vnd' }),
    fx.cny_vnd ? t('money.rateCny', formatMoney(fx.cny_vnd, { currency: 'vnd' })) : '',
    fx.source || '', !!fx.stale)
  : t('money.noRate')

function useBalance(enabled) {
  return useQuery({
    queryKey: BALANCE_KEY,
    queryFn: () => api('/balance'),
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    staleTime: 30000
  })
}

/* A new call is prepended straight into the cache, so the log moves without a refetch.
 * The gateway hands the listener the whole event frame ({type, session_id, payload}) and the row is the
 * payload: reading the frame as if it were the row drops every live call silently, because `frame.ts`
 * is undefined and the guard below then returns early. */
function useCallFeed() {
  useEffect(() => {
    if (!onEvent || !queryClient) return undefined
    return onEvent('plugin.' + PLUGIN_ID + '.call', event => {
      const row = event && event.payload
      if (!row || !row.ts) return
      if ($mode.get() === 'vilao') {
        /* The hook row is Hermes' estimate; the Vilao mode lists what the account was charged, and
         * that only exists after the pulse reads the bill. */
        queryClient.invalidateQueries({ queryKey: VILAO_KEY })
        return
      }
      for (const base of [CALLS_KEY, VILAO_KEY]) {
        const cached = queryClient.getQueryData(base)
        if (!cached || !Array.isArray(cached.calls)) continue
        /* Prepending belongs to the newest page only; shoving a row into page 4 would show a call that
         * is not part of that slice, and the pager's count would disagree with the table. */
        if (cached.page !== 1) continue
        if (cached.calls.some(c => c.ts === row.ts && c.model === row.model)) continue
        queryClient.setQueryData(base, {
          ...cached,
          calls: [row, ...cached.calls].slice(0, cached.per || 100),
          total: (Number(cached.total) || 0) + 1
        })
      }
    })
  }, [])
}

function refreshCaches() {
  if (!queryClient) return
  queryClient.invalidateQueries(SUMMARY_KEY)
  queryClient.invalidateQueries(CALLS_KEY)
  queryClient.invalidateQueries(VILAO_KEY)
  queryClient.invalidateQueries(BALANCE_KEY)
}

/* The backend pulls a few pages per request; the page drives the walk until vilao reports done.
 * No worker thread on our side, so a long backfill never holds an HTTP request open.
 *
 * ``pulse`` is the routine refresh: it stops at the first page that is already known, so keeping the
 * log current costs the new rows rather than a re-read of the whole horizon. ``full`` walks everything
 * vilao still bills for, and a plain walk covers the stored 30 days -- what refills the API-key tags
 * on rows ingested before the bill carried them. */
/* The backend pulls a few pages per request and keeps the cursor; the page drives the walk. No worker
 * thread on our side, so a long backfill never holds an HTTP request open.
 *
 * ``pulse`` is the routine refresh: newest pages only, stopping at the first page already known, so
 * keeping the log current costs the new rows rather than a re-read of the horizon.
 *
 * ``restart`` is sent on the FIRST request of a deep run only. The walk resumes from the saved cursor,
 * and a run that restarted every request would re-read the same newest pages forever and never reach
 * the older charges -- which is how a twelve-month grid stays half empty. */
async function runSync({ days = 30, pulse = false, restart = false } = {}) {
  $error.set(null)
  const steps = pulse ? 4 : (days >= 365 ? 200 : 60)
  for (let step = 0; step < steps; step++) {
    let body = null
    try {
      body = await api('/sync?' + q({ pages: 3, days, pulse: pulse ? 1 : '',
        restart: restart && step === 0 ? 1 : '' }), { method: 'POST' })
    } catch (err) {
      $error.set(String((err && err.message) || err))
      return
    }
    $sync.set(body)
    if (!body || body.started === false) { refreshCaches(); return }
    refreshCaches()
    if (body.done) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

function useFirstRunBackfill(days) {
  const started = useRef(false)
  const summary = useSummary(days)
  useEffect(() => {
    if (started.current || !summary.data) return
    started.current = true
    const rows = Number((summary.data.summary || {}).calls || 0)
    // An empty store has nothing to lose: read the year the calendar draws. A filled one just refreshes.
    runSync(rows === 0 ? { days: 365, restart: true } : { pulse: true })
  }, [summary.data])
  return summary
}

/* ---------- primitives ---------- */

/* The page is painted by whatever skin the app is wearing, so colour comes from the app's own tokens
 * with a neutral fallback. A native <select> was the one place that could not be themed: its popup is
 * drawn by the OS, and over a dark surface it arrived as a white box with the page's light text on it. */
const tk = (name, fallback) => 'var(' + name + ', ' + fallback + ')'
const INK = tk('--ui-text-primary', 'currentColor')
const INK_FAINT = tk('--ui-text-secondary', 'rgba(128,128,128,0.85)')
const HAIRLINE = tk('--ui-stroke-tertiary', 'rgba(128,128,128,0.22)')
const EDGE = tk('--ui-stroke-secondary', 'rgba(128,128,128,0.32)')
const FILL = tk('--ui-control-hover-background', 'rgba(128,128,128,0.14)')
const PANEL = tk('--ui-widget-surface-background', tk('--ui-bg-chrome', 'rgba(128,128,128,0.16)'))
const TRACK = 'rgba(128,128,128,0.20)'
const ACCENT = tk('--ui-accent', 'currentColor')

const gap = { display: 'flex', gap: 8, alignItems: 'center' }
const card = { border: '1px solid ' + HAIRLINE, borderRadius: 8, padding: 12 }
const faint = { color: INK_FAINT, fontSize: 11 }
const mono = { fontVariantNumeric: 'tabular-nums' }
const numCell = { ...mono, textAlign: 'right', whiteSpace: 'nowrap' }
const field = { ...gap, justifyContent: 'space-between', gap: 6, padding: '3px 8px', fontSize: 12,
  borderRadius: 6, border: '1px solid ' + HAIRLINE, background: 'transparent', color: INK, cursor: 'pointer' }

function Stat({ label, value, hint }) {
  return jsx('div', { style: { ...card, minWidth: 130 }, children: jsxs('div', { children: [
    jsx('div', { style: faint, children: label }),
    jsx('div', { style: { fontSize: 19, fontWeight: 600, ...mono, color: INK }, children: value }),
    hint ? jsx('div', { style: faint, children: hint }) : null
  ] }) })
}

/* One option row, reused by the segmented control and the dropdown. */
function Choice({ on, onClick, children, wide }) {
  return jsx('button', {
    type: 'button', onClick, 'aria-pressed': on,
    style: { ...gap, justifyContent: 'space-between', gap: 10, width: wide ? '100%' : 'auto',
      padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: INK,
      background: on ? FILL : 'transparent', border: '1px solid ' + (on ? EDGE : 'transparent'),
      textAlign: 'left' },
    children
  })
}

function Segmented({ options, value, onChange }) {
  return jsx('div', { style: { ...gap, gap: 4 }, children: options.map(o => jsx(Choice, {
    on: value === o.value, onClick: () => onChange(o.value), children: o.label
  }, o.value || 'all')) })
}

/* A themed dropdown that replaces <select>: the trigger and the list are both our own DOM, so both
 * pick up the active skin. Keyboard: Escape closes, Enter/Space picks. */
function Pick({ label, value, options, onChange, width }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const current = options.find(o => o.value === value) || options[0]
  useEffect(() => {
    if (!open) return undefined
    const away = e => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const key = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return jsxs('div', { ref: box, style: { position: 'relative', width: width || undefined }, children: [
    jsxs('button', {
      type: 'button', onClick: () => setOpen(v => !v), 'aria-haspopup': 'listbox', 'aria-expanded': open,
      title: current ? current.title || current.label : '',
      style: { ...field, minWidth: 120, width: '100%' },
      children: [
        jsx('span', { style: { ...faint, marginRight: 6 }, children: label }),
        jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          children: current ? current.label : '—' }),
        jsx('span', { style: { ...faint, transform: open ? 'rotate(180deg)' : 'none' }, children: '▾' })
      ]
    }),
    open ? jsx('div', {
      role: 'listbox',
      style: { position: 'absolute', zIndex: 30, top: '100%', left: 0, marginTop: 4, minWidth: '100%',
        maxHeight: 280, overflowY: 'auto', padding: 4, borderRadius: 8, background: PANEL,
        border: '1px solid ' + EDGE, boxShadow: '0 10px 28px rgba(0,0,0,0.35)' },
      children: jsxs('div', { style: { display: 'grid', gap: 2 }, children: options.map(o => jsxs('button', {
        type: 'button', role: 'option', 'aria-selected': o.value === value,
        onClick: () => { onChange(o.value); setOpen(false) },
        title: o.title || o.label,
        style: { ...gap, justifyContent: 'space-between', gap: 12, width: '100%', padding: '4px 8px',
          borderRadius: 6, fontSize: 12, color: INK, cursor: 'pointer', border: 'none',
          background: o.value === value ? FILL : 'transparent', textAlign: 'left' },
        children: [
          jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: o.label }, o.value),
          jsx('span', { style: { ...faint, flexShrink: 0 }, children: o.meta || (o.value === value ? '●' : '') },
            o.value + 'm')
        ]
      }, o.value)) })
    }) : null
  ] })
}

function TabBar() {
  const active = useValue($tab)
  return jsx('div', { style: { display: 'flex', gap: 4, borderBottom: '1px solid rgba(128,128,128,0.28)', padding: '8px 0' },
    children: TABS.map(key => jsx('button', {
      type: 'button',
      onClick: () => $tab.set(key),
      style: { ...gap, padding: '4px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
        background: active === key ? 'rgba(128,128,128,0.22)' : 'transparent',
        color: 'inherit', border: '1px solid transparent' },
      children: TAB_LABEL()[key]
    }, key)) })
}

function Banner() {
  const err = useValue($error)
  const sync = useValue($sync)
  if (!err && !sync) return null
  if (err) return jsx('div', { style: { ...faint, padding: '6px 0' },
    children: t('sync.error', String(err).slice(0, 180)) })
  const label = sync.pending
    ? t('sync.scanning', sync.days || 30, sync.page || 1, sync.read || 0)
    : t('sync.done', sync.read || 0, sync.stored || 0, sync.matched || 0)
  return jsx('div', { style: { ...faint, padding: '6px 0' }, children: label })
}

/* Label | bar | value on one grid row, so the numbers of every row share a column. */
function Bars({ rows, valueKey, labelKey, format, max, titleKey }) {
  const top = max || Math.max(1, ...rows.map(r => Number(r[valueKey]) || 0))
  return jsx('div', { style: { display: 'grid', gap: 5 }, children: rows.map(r => {
    const value = Number(r[valueKey]) || 0
    return jsxs('div', {
      style: { display: 'grid', gridTemplateColumns: 'minmax(90px, 170px) 1fr auto', gap: 10,
        alignItems: 'center', fontSize: 12 },
      children: [
        jsx('span', { style: { ...mono, color: INK, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' }, title: titleKey ? r[titleKey] : String(r[labelKey]),
          children: String(r[labelKey]) }),
        jsx('span', { style: { height: 7, borderRadius: 4, background: TRACK, overflow: 'hidden' },
          children: jsx('span', { style: { display: 'block', height: '100%',
            width: (value / top * 100).toFixed(1) + '%', borderRadius: 4,
            background: ACCENT, opacity: 0.55 } }) }),
        jsx('span', { style: { ...numCell, minWidth: 74 }, children: format(value) })
      ]
    }, String(r[labelKey]))
  }) })
}

/* A line chart in plain SVG: no chart library is bundled with the desktop plugin host, and 30 points of
 * daily totals do not need one. Two series so the two questions people actually ask sit on one axis --
 * how much money, and how much work -- each scaled to its own maximum because dong and token counts
 * never share a sensible scale. */
function Lines({ rows, series, height = 128 }) {
  if (!rows || !rows.length) return jsx('div', { style: faint, children: '—' })
  const w = 100, pad = 3
  const step = rows.length > 1 ? (w - pad * 2) / (rows.length - 1) : 0
  const firstRow = rows[0], lastRow = rows[rows.length - 1]
  return jsxs('div', { style: { display: 'grid', gap: 6 }, children: [
    ...series.map(s => {
      const values = rows.map(r => Number(r[s.key]) || 0)
      const top = Math.max(1, ...values)
      const pts = values.map((v, i) => (pad + i * step).toFixed(2) + ',' +
        (100 - (v / top) * 92).toFixed(2))
      return jsxs('div', { style: { display: 'grid', gap: 2 }, children: [
        jsxs('div', { style: { ...gap, justifyContent: 'space-between' }, children: [
          jsx('span', { style: { ...faint, color: s.color || ACCENT }, children: s.label }, 'l'),
          jsx('span', { style: { ...numCell, fontSize: 11, color: INK },
            children: t('chart.peak', s.format(top)) }, 'm')
        ] }),
        jsx('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none',
          style: { width: '100%', height, display: 'block', overflow: 'visible' },
          children: jsx('polyline', { fill: 'none', stroke: s.color || ACCENT, strokeWidth: 0.8,
            strokeLinejoin: 'round', strokeLinecap: 'round', points: pts.join(' ') }) }, s.key)
      ] }, s.key)
    }),
    jsxs('div', { style: { ...gap, justifyContent: 'space-between', ...faint, fontSize: 10 }, children: [
      jsx('span', { children: t('chart.spanFrom', String(rows.length),
        String((firstRow && firstRow.day) || '—')) }, 'a'),
      jsx('span', { children: t('chart.spanTo', String((lastRow && lastRow.day) || '—'),
        series[0].label, series[0].format(Number(lastRow && lastRow[series[0].key]) || 0)) }, 'b')
    ] }, 'axis')
  ] })
}

/* GitHub's contribution graph, drawn the same way: seven weekday rows, one square per day, and enough
 * week columns to cover twelve months. Cells stay square rather than stretching to the pane, and the
 * grid scrolls sideways when the window is narrower than the year -- which it always is.
 *
 * Intensity is that day's billed dong, and the tooltip names the models that day's money went to, so
 * the day x model detail this replaced is still one hover away. Days the store never ingested look
 * exactly like days that cost nothing, so the card states the window it actually holds. */
const CELL = 13
const CELL_GAP = 3
const GUTTER = 30

function dayKey(date) {
  const pad = n => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/* One calendar year as whole weeks starting Monday: Jan 1 is pulled back to the Monday before it and
 * Dec 31 pushed to the Sunday after, so every column is a week and T1 always comes first. The old view
 * was a rolling 365 days, which started wherever the year happened to be and read as T10 → T10. */
function weekColumns(year) {
  const start = new Date(year, 0, 1)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const end = new Date(year, 11, 31)
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cols = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const row = (d.getDay() + 6) % 7
    if (row === 0) cols.push([])
    cols[cols.length - 1].push(dayKey(d))
  }
  return { cols: cols.map(c => { while (c.length < 7) c.push(null); return c }), today: dayKey(today) }
}

const MONTH_LABEL = m => t('calendar.month', m)

function Calendar({ matrix, bill }) {
  const picked = useValue($day)
  const byDay = useMemo(() => {
    const acc = new Map()
    for (const r of matrix) {
      const item = acc.get(r.day) || { calls: 0, dong: 0, models: [] }
      item.calls += Number(r.calls) || 0
      item.dong += Number(r.dong) || 0
      item.models.push([shortModel(r.model_key), Number(r.dong) || 0])
      acc.set(r.day, item)
    }
    for (const v of acc.values()) v.models.sort((a, b) => b[1] - a[1])
    return acc
  }, [matrix])
  const year = new Date().getFullYear()
  const { cols: weeks, today } = useMemo(() => weekColumns(year), [year])
  const peak = Math.max(1, ...Array.from(byDay.values(), v => v.dong))
  const firstDay = bill && bill.first_ts ? dayKey(new Date(bill.first_ts * 1000)) : '0000-00-00'
  const filled = Array.from(byDay.values()).filter(v => v.dong > 0).length
  let shownMonth = -1
  /* The first column usually begins in the December before Jan 1 (weeks are whole), and the last one can
   * finish in the January after Dec 31. Labelling those cells would print T12 before T1, so a column is
   * labelled from the first day inside the year it actually belongs to. */
  const months = weeks.map(w => {
    const inYear = w.filter(d => d && String(d).slice(0, 4) === String(year))
    const m = inYear.length ? Number(String(inYear[0]).slice(5, 7)) : 0
    const label = m && m !== shownMonth ? MONTH_LABEL(m) : ''
    if (label) shownMonth = m
    return label
  })
  const cols = `repeat(${weeks.length}, ${CELL}px)`
  const cellStyle = o => ({ width: CELL, height: CELL, borderRadius: 2, background: 'currentColor',
    opacity: o })
  return jsxs('div', { style: { position: 'relative', paddingLeft: GUTTER }, children: [
    jsx('div', { style: { ...faint, position: 'absolute', left: 0, top: 16, display: 'grid',
      gridTemplateRows: `repeat(7, ${CELL + CELL_GAP}px)`, gap: CELL_GAP, fontSize: 9, width: GUTTER,
      fontVariantNumeric: 'tabular-nums' },
      children: [t('calendar.mon'), '', t('calendar.wed'), '', t('calendar.fri'), '', ''].map((w, i) =>
        jsx('span', { style: { height: CELL, lineHeight: CELL + 'px' }, children: w }, 'w' + i)) }),
    jsx('div', { style: { overflowX: 'auto', paddingBottom: 4 }, children: jsxs('div', { children: [
      jsx('div', { style: { display: 'grid', gridTemplateColumns: cols, gap: CELL_GAP, height: 14,
        marginBottom: 2 }, children: months.map((m, i) =>
        jsx('span', { style: { fontSize: 9, color: INK_FAINT, whiteSpace: 'nowrap' }, children: m },
          'm' + i)) }),
      jsx('div', { style: { display: 'grid', gridTemplateColumns: cols, gridTemplateRows:
        `repeat(7, ${CELL}px)`, gridAutoFlow: 'column', gap: CELL_GAP, width:
        weeks.length * (CELL + CELL_GAP) },
        children: weeks.flatMap((w, i) => w.map((day, row) => {
          if (!day) return jsx('div', { style: cellStyle(0) }, 'e' + i + row)
          const item = byDay.get(day)
          const value = item ? item.dong : 0
          const future = day > today
          const tip = new Date(day + 'T12:00:00').toLocaleDateString('vi-VN')
          const chosen = day === picked
          /* A square is a question and an answer at once: it shows the day's spend and, on click, opens
           * the log filtered to exactly that day. The empty ones stay clickable too -- "what happened on
           * a day I spent nothing" is a real question, and an unresponsive cell reads as a broken grid. */
          return jsx('button', {
            type: 'button',
            onClick: () => { $day.set(chosen ? '' : day); $page.set(1); if (!chosen) $tab.set('live') },
            title: (value > 0
              ? [tip + ' · ' + dong(value), t('calendar.callsTip', item.calls || 0),
                 item.models.slice(0, 3).map(x => x[0] + ' ' + dong(x[1])).join(', ')].join('\n')
              : future ? t('calendar.future', tip)
              : day < firstDay ? t('calendar.beforeData', tip,
                firstDay.slice(8) + '/' + firstDay.slice(5, 7))
              : t('calendar.noSpend', tip)) + '\n' + t('calendar.openLog'),
            style: { ...cellStyle(value > 0 ? Math.max(0.15, Math.min(1, value / peak))
              : future ? 0.02 : day < firstDay ? 0.04 : 0.07),
              border: chosen ? '1px solid ' + ACCENT : '1px solid transparent', padding: 0,
              cursor: future ? 'default' : 'pointer', outline: 'none' }
          }, day)
        })) })
    ] }) }),
    jsxs('div', { style: { ...gap, justifyContent: 'space-between', marginTop: 8 }, children: [
      jsx('span', { style: faint, children: bill && bill.first_ts
        ? t('calendar.yearLegend', year, clockOf(bill.first_ts).slice(0, 10), filled)
        : t('calendar.noBill') }),
      jsxs('div', { style: gap, children: [
        jsx('span', { style: faint, children: t('calendar.less') }),
        [0.15, 0.35, 0.6, 0.85, 1].map(o => jsx('span', { style: { width: 11, height: 11,
          borderRadius: 2, flexShrink: 0, background: 'currentColor', opacity: o } }, 'l' + o)),
        jsx('span', { style: faint, children: t('calendar.more') })
      ] })
    ] })
  ] })
}

/* ---------- tabs ---------- */

/* Option lists are functions for the same reason as the column lists: a const would freeze the English
 * labels in at import, whatever the language the page later resolves to. */
const RANGES = () => [{ value: '', label: t('live.range.all') }, { value: '24', label: t('live.range.h24') },
  { value: '168', label: t('live.range.d7') }, { value: '720', label: t('live.range.d30') }]
const OUTCOMES = () => [{ value: '', label: t('live.outcome.all') }, { value: 'ok', label: t('live.outcome.ok') },
  { value: 'error', label: t('live.outcome.error') }]
const MATCH_STATE = () => ({ matched: t('live.match.matched'), local_only: t('live.match.localOnly'),
  bill_only: t('live.match.billOnly') })

/* Two feeds, one table. 'hermes' is every call the agent logged through any provider; 'vilao' is the
 * account's own bill, which also carries calls Hermes never saw (other machines, other keys). */
function homeOptions(rows) {
  /* Every home the store has calls for, plus the billing bucket: a vilao charge is an account-level
   * event, so it carries no home and would otherwise be unreachable once the filter exists. */
  const out = [{ value: '', label: t('live.homeAll') }]
  for (const h of rows || []) {
    if (!h.profile) {
      out.push({ value: NO_HOME, label: t('live.homeBill'),
        meta: t('live.homeMeta', tok(h.calls), dong(h.dong)),
        title: t('live.homeBillTitle') })
      continue
    }
    out.push({ value: h.profile, label: h.profile,
      meta: t('live.homeMeta', tok(h.calls), dong(h.dong)),
      title: h.profile + ' · ' + num(h.last_ts ? longOf(h.last_ts) : '') })
  }
  return out
}

/* Page numbers around the current page, so a 400-page table still fits in one row of buttons. */
function pageList(page, pages) {
  const out = []
  const push = p => { if (p >= 1 && p <= pages && out[out.length - 1] !== p) out.push(p) }
  push(1)
  for (let p = page - 2; p <= page + 2; p++) push(p)
  push(pages)
  return out.filter((p, i, a) => i === 0 || p !== a[i - 1])
}

/* The Pager of whichever table is on screen claims this slot, so one keyboard handler can page through
 * the Live log or the offer catalogue without either tab plumbing its page count up to the shell. */
const PAGER = { go: null }

function Pager({ data, onPage }) {
  const total = Number(data && data.total) || 0
  const pages = Number(data && data.pages) || 1
  const page = Number(data && data.page) || 1
  useEffect(() => {
    if (!total) return undefined
    PAGER.go = d => {
      const next = Math.min(pages, Math.max(1, page + d))
      if (next !== page) onPage(next)
    }
    return () => { PAGER.go = null }
  }, [page, pages, total])
  if (!total) return null
  const btn = { padding: '2px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
    border: '1px solid ' + HAIRLINE, background: 'transparent', color: INK }
  const off = { ...btn, opacity: 0.45, cursor: 'default' }
  const go = p => { if (p >= 1 && p <= pages) { onPage(p); $openRow.set(null) } }
  return jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
      borderTop: '1px solid ' + EDGE, flexWrap: 'wrap' }, children: [
    jsx('span', { style: { ...faint, fontSize: 11 },
      children: t('live.pager', page, pages, num(total), data.per || PER_PAGE) }, 'info'),
    jsx('button', { type: 'button', style: page > 1 ? btn : off, onClick: () => go(1), children: '«' }, 'first'),
    jsx('button', { type: 'button', style: page > 1 ? btn : off, onClick: () => go(page - 1),
      children: t('live.prev') }, 'prev'),
    ...pageList(page, pages).map(p => jsx('button', {
      type: 'button',
      style: p === page ? { ...btn, borderColor: ACCENT, color: ACCENT, fontWeight: 600 } : btn,
      onClick: () => go(p), children: String(p) }, p)),
    jsx('button', { type: 'button', style: page < pages ? btn : off, onClick: () => go(page + 1),
      children: t('live.next') }, 'next'),
    jsx('button', { type: 'button', style: page < pages ? btn : off, onClick: () => go(pages), children: '»' }, 'last')
  ] })
}

function LiveTab() {
  const mode = useValue($mode)
  const vilao = mode === 'vilao'
  const provider = useValue($provider)
  const key = useValue($key)
  const range = useValue($range)
  const outcome = useValue($outcome)
  const search = useValue($search)
  const mainOnly = useValue($mainOnly)
  const profile = useValue($profile)
  const day = useValue($day)
  const hermes = useCalls(!vilao)
  const billed = useVilaoCalls(vilao)
  const keys = useKeys(vilao)
  const open = useValue($openRow)
  const query = vilao ? billed : hermes
  const rows = (query.data && query.data.calls) || []
  const byId = useMemo(() => {
    const map = {}
    for (const k of (keys.data && keys.data.keys) || []) map[k.id] = k
    return map
  }, [keys.data])
  const profiles = useProfiles()
  const homeRows = (profiles.data && profiles.data.profiles) || []
  const providers = useMemo(() => Array.from(new Set(rows.map(r => r.provider).filter(Boolean))).sort(), [rows])
  const hotDong = useMemo(() => quantile(rows, 'bill_cost_vnd', 0.9), [rows])
  const slowMs = useMemo(() => quantile(rows, 'duration_ms', 0.85), [rows])
  const keyOptions = useMemo(() => {
    const used = Array.from(new Set(rows.map(r => r.bill_key_id).filter(Boolean)))
    const seen = new Set()
    const opts = [{ value: '', label: t('live.keyAll') }]
    for (const k of (keys.data && keys.data.keys) || []) {
      if (seen.has(k.id)) continue
      seen.add(k.id)
      opts.push({ value: k.id, label: k.name || k.key_prefix,
        meta: k.active ? dong(Number(k.total_spent) || 0) : t('live.keyStopped', dong(Number(k.total_spent) || 0)),
        title: t('live.keyMeta', k.key_prefix, num(k.total_requests)) })
    }
    for (const id of used) if (!seen.has(id)) opts.push({ value: id, label: id.slice(0, 8), meta: t('live.keyUnlisted') })
    return opts
  }, [keys.data, rows])
  return jsxs('div', { style: { display: 'grid', gap: 10 }, children: [
    jsxs('div', { style: { ...gap, flexWrap: 'wrap', rowGap: 8 }, children: [
      jsx(Segmented, { options: [
        { value: 'hermes', label: t('live.modeHermes') }, { value: 'vilao', label: t('live.modeVilao') }
      ], value: mode, onChange: v => { $mode.set(v); $page.set(1) } }),
      vilao
        ? jsx(Pick, { label: t('live.pickKey'), value: key, options: keyOptions,
            onChange: v => { $key.set(v); $page.set(1) }, width: 230 })
        : jsx(Pick, { label: t('live.pickProvider'), value: provider,
            options: [{ value: '', label: t('live.providerAll') }, ...providers.map(p => ({ value: p, label: p }))],
            onChange: v => { $provider.set(v); $page.set(1) }, width: 190 }),
      jsx(Pick, { label: t('live.pickHome'), value: profile, width: 210,
          options: homeOptions(homeRows),
          onChange: v => { $profile.set(v); $page.set(1) } }),
      jsx(Pick, { label: t('live.pickRange'), value: range, options: RANGES(),
        onChange: v => { $range.set(v); $page.set(1) }, width: 168 }),
      /* The chip exists because a day filter silently overrides the range: without a visible record of
       * it, "why is the log showing October 3rd" has no answer on screen. */
      day ? jsxs('button', {
        type: 'button', onClick: () => { $day.set(''); $page.set(1) },
        title: t('live.dayChipTitle'),
        style: { ...field, border: '1px solid ' + ACCENT, color: ACCENT },
        children: [jsx('span', { children: t('live.dayChip', day.slice(8) + '/' + day.slice(5, 7)) }),
          jsx('span', { children: ' ✕' })]
      }, 'day') : null,
      jsx(Pick, { label: t('live.pickOutcome'), value: outcome, options: OUTCOMES(),
        onChange: v => { $outcome.set(v); $page.set(1) }, width: 168 }),
      jsx('input', { style: { ...field, minWidth: 170, cursor: 'text' }, placeholder: t('live.filterModel'),
        'data-usage-search': 'live', value: search,
        onChange: e => { $search.set(e.target.value); $page.set(1) } }),
      vilao ? null : jsxs('label', { style: { ...gap, fontSize: 12, cursor: 'pointer', color: INK }, children: [
        jsx('input', { type: 'checkbox', checked: mainOnly,
          onChange: e => { $mainOnly.set(e.target.checked); $page.set(1) } }),
        t('live.mainOnly')
      ] }),
      jsx('button', { type: 'button', style: { ...field, border: '1px solid ' + HAIRLINE },
        title: t('live.syncPulseTitle'),
        onClick: () => runSync({ pulse: true }), children: t('live.syncPulse') }),
      jsx('button', { type: 'button', style: { ...field, border: '1px solid ' + HAIRLINE },
        title: t('live.syncRestartTitle'),
        onClick: () => runSync({ days: 30, restart: true }), children: t('live.syncRestart') })
    ] }),
    vilao ? jsx('div', { style: faint, children: rows.length
      ? t('live.billNote', num((query.data || {}).total || 0))
      : t('live.billEmpty') }) : null,
    query.isError ? jsx('div', { style: faint, children: t('live.readFail', String(query.error)) }) : null,
    rows.length ? jsxs('div', { style: { ...card, padding: 0, overflowX: 'auto' }, children: [
      jsx('div', { style: { ...LOG_GRID, padding: '4px 10px', minWidth: 900 },
        children: LOG_CELLS().map((c, j) => jsx('span', { style: { ...faint, fontSize: 10,
          textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: j > 3 ? 'right' : 'left' },
          children: c }, c)) }),
      ...rows.map((row, i) => jsx(CallRow, { row, i, byId, vilao,
        hotDong, slowMs }, row.id || i)),
      jsx(LogTotals, { rows, data: query.data }),
      jsx(Pager, { data: query.data, onPage: p => $page.set(p) })
    ] }) : jsx('div', { style: { ...card, ...faint }, children: t('live.emptyStore') }),
    open ? jsx(RowDetail, { row: open, byId }) : null
  ] })
}

/* One grid definition, shared by the header and the rows, so every number sits in its own column.
 * Tokens get their own columns because "how much did I burn" is only half the question: the other half
 * is how much context went through the cache, which is what actually drives the dong. */
/* The store is shared by every profile, so a row without its profile is a row that cannot be
 * attributed -- one key column is not enough once a second machine starts calling too. */
const LOG_GRID = { display: 'grid', gridTemplateColumns: '78px 68px 74px minmax(110px, 1fr) 92px 88px 62px 72px 50px 82px',
  gap: 8, alignItems: 'center' }
/* The Live log header: one label per LOG_GRID column, read as a function so the labels follow the
 * resolved language rather than the language the module happened to be imported in. */
function LOG_CELLS() {
  return [t('live.col.clock'), t('live.col.date'), t('live.col.home'), t('live.col.model'),
    t('live.col.keyProvider'), t('live.col.inOut'), t('live.col.cache'), t('live.col.tokens'),
    t('live.col.delay'), t('live.col.dong')]
}

/* Colour follows the content, not a fixed style: a call is only flagged against what the loaded window
 * actually looks like, so "expensive" means expensive today, not expensive against a constant. */
function quantile(rows, key, q) {
  const v = rows.map(r => Number(r[key]) || 0).filter(x => x > 0).sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : Infinity
}

const HOT = 'text-amber-600 dark:text-amber-300'

function CallRow({ row, i, byId, vilao, hotDong, slowMs }) {
  const src = vilao ? keyName(byId, row.bill_key_id) : (row.provider || '?')
  const failed = row.finish_reason === 'error'
  const cost = Number(row.bill_cost_vnd) || 0
  const total = Number(row.tok_total) || 0
  const cache = Number(row.tok_cache_read) || 0
  const slow = row.duration_ms && row.duration_ms >= slowMs
  return jsxs('div', {
    onClick: () => $openRow.set(row),
    title: longOf(row.ts) + ' · ' + (row.model || '?') + (failed ? ' · FAILED' : ''),
    style: { ...LOG_GRID, padding: '5px 10px', fontSize: 12, color: INK, cursor: 'pointer',
      borderTop: '1px solid ' + HAIRLINE, background: i % 2 ? 'transparent' : 'rgba(128,128,128,0.04)' },
    children: [
      jsxs('span', { style: { ...mono, fontSize: 11, color: INK_FAINT }, children: [
        String(clockOf(row.ts)),
        Date.now() / 1000 - Number(row.ts) < 90 ? jsx('span', { className: HOT, style: { marginLeft: 5,
          fontSize: 9 }, children: '●' }) : null
      ] }),
      jsx('span', { style: { ...mono, fontSize: 11, color: INK_FAINT }, children: dateOf(row.ts) }),
      jsx('span', { style: { ...faint, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' },
        title: row.profile ? 'home: ' + row.profile : t('live.rowHomeTitle'),
        children: row.profile || t('live.rowHomeBill') }),
      jsxs('span', { style: { ...mono, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' }, title: row.model, children: [
        /* Clicking the name filters the log to that model -- the row's own click opens the detail, so
         * the two actions have to stay separate or one of them is unreachable. */
        jsx('button', {
          type: 'button', title: t('live.rowModelTitle'),
          onClick: e => { e.stopPropagation(); $search.set(row.model_key || row.model || ''); $page.set(1) },
          style: { background: 'transparent', border: 'none', padding: 0, margin: 0, font: 'inherit',
            color: 'inherit', cursor: 'pointer', maxWidth: '100%', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
          children: String(shortModel(row.model)) }),
        row.task ? jsx('span', { style: { ...faint, marginLeft: 6, fontSize: 10 },
          children: 'aux:' + row.task }) : null,
        failed ? jsx('span', { className: HOT, style: { marginLeft: 6, fontSize: 10 },
          children: t('live.rowError') }) : null
      ] }),
      jsx('span', { style: { ...faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: src, children: src }),
      jsxs('span', { style: { ...numCell, fontSize: 11 }, children: [
        String(tok(row.tok_in)), ' → ', String(tok(row.tok_out))
      ] }),
      jsx('span', { style: { ...numCell, fontSize: 11, ...(total && cache / total > 0.5
        ? { color: ACCENT } : {}) }, title: total ? t('live.cacheShare', pct(cache / total * 100)) : '',
        children: String(tok(cache)) }),
      jsx('span', { style: { ...numCell, fontWeight: 600 }, children: String(tok(total)) }),
      jsx('span', { className: slow ? HOT : undefined, style: numCell,
        children: row.duration_ms ? (row.duration_ms / 1000).toFixed(1) + 's' : '—' }),
      jsxs('span', { className: cost >= hotDong ? HOT : undefined, style: numCell, children: [
        String(money(row)),
        row.match_state === 'local_only' ? jsx('span', { style: { ...faint, fontWeight: 400, fontSize: 10 },
          children: ' ' + t('live.estTag') }) : null
      ] })
    ]
  })
}

/* A totals strip, so the window you are looking at answers "how much" without scrolling to a card.
 * Cache share is the number that actually explains the dong, so it gets its own slot. */
function LogTotals({ rows, data }) {
  const s = rows.reduce((a, r) => {
    a.tokIn += Number(r.tok_in) || 0
    a.tokOut += Number(r.tok_out) || 0
    a.cache += Number(r.tok_cache_read) || 0
    a.total += Number(r.tok_total) || 0
    a.dong += Number(r.bill_cost_vnd) || 0
    a.usd += Number(r.est_cost_usd) || 0
    a.ms += Number(r.duration_ms) || 0
    if (r.profile) a.homes[r.profile] = 1
    a.n += 1
    return a
  }, { tokIn: 0, tokOut: 0, cache: 0, total: 0, dong: 0, usd: 0, ms: 0, n: 0, homes: {} })
  if (!s.n) return null
  const cell = (k, v, strong) => jsx('span', { style: { ...numCell, fontSize: 11,
    fontWeight: strong ? 600 : 400, color: strong ? INK : INK_FAINT }, children: v }, k)
  return jsx('div', { style: { ...LOG_GRID, padding: '6px 10px', borderTop: '1px solid ' + EDGE,
    background: 'rgba(128,128,128,0.06)' }, children: [
    jsx('span', { style: { ...faint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' },
      children: t('live.totalsLabel') }, 'l'),
    jsx('span', { style: { ...faint, fontSize: 10 },
      children: t('live.totalsRows', s.n, num((data && data.per) || PER_PAGE)) }, 'n'),
    jsx('span', { style: { ...faint, fontSize: 10 },
      children: t('live.totalsHomes', Object.keys(s.homes).length) }, 'h'),
    jsx('span', { style: { ...faint, fontSize: 10 },
      children: t('live.totalsMatched', num(((data && data.total) || s.n))) }, 'w'),
    cell(t('live.totalsCache', pct(s.total ? s.cache / s.total * 100 : 0)), false),
    cell(tok(s.tokIn), false),
    cell(tok(s.tokOut), false),
    cell(tok(s.total), true),
    cell(s.n ? (s.ms / s.n / 1000).toFixed(1) + 's' : '—', false),
    cell(s.dong ? dong(s.dong) : est(s.usd), true)
  ].filter(Boolean) })
}

function RowDetail({ row, byId }) {
  const fields = [
    [t('detail.time'), longOf(row.ts)],
    [t('detail.providerModel'), (row.provider || '?') + ' · ' + (row.model || '?')],
    [t('detail.vilaoKey'), row.bill_key_id ? keyName(byId, row.bill_key_id) : '—'],
    [t('detail.apiMode'), row.api_mode || '—'],
    [t('detail.session'), row.session_id || '—'],
    [t('detail.platform'), row.platform || '—'],
    [t('detail.kind'), row.task ? t('detail.aux') + ' · ' + row.task : t('detail.main')],
    [t('detail.tokensInOut'), num(row.tok_in) + ' / ' + num(row.tok_out)],
    [t('detail.cacheReadWrite'), num(row.tok_cache_read) + ' / ' + num(row.tok_cache_write)],
    [t('detail.reasoning'), num(row.tok_reasoning)],
    [t('detail.delayTtft'), (row.duration_ms ? (row.duration_ms / 1000).toFixed(2) + 's' : '—') + ' / ' + (row.ttft_ms ? (row.ttft_ms / 1000).toFixed(2) + 's' : '—')],
    [t('detail.result'), row.finish_reason === 'error' ? t('detail.error') : (row.finish_reason || '—')],
    [t('detail.context'), row.context_length ? num(row.context_length) : '—'],
    [t('detail.hermesEstimate'), est(row.est_cost_usd), estTitle(row.est_cost_usd)],
    [t('detail.vilaoBill'), row.bill_cost_vnd != null ? dong(row.bill_cost_vnd) : '—'],
    [t('detail.billMatch'), MATCH_STATE()[row.match_state] || row.match_state]
  ]
  return jsx('div', { style: { ...card, position: 'relative' }, children: jsxs('div', { children: [
    jsxs('div', { style: { ...gap, justifyContent: 'space-between' }, children: [
      jsx('strong', { children: t('detail.title') }),
      jsx(Choice, { on: false, onClick: () => $openRow.set(null), children: t('detail.close') })
    ] }),
    jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 4, marginTop: 8 },
      children: fields.map(([k, v, tip]) => jsxs('div', { style: { ...gap, justifyContent: 'space-between', fontSize: 12 }, children: [
        jsx('span', { style: faint, children: k }),
        jsx('span', { style: { ...mono, color: INK, textAlign: 'right', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: tip || String(v),
          children: String(v) })
      ] }, k)) })
  ] }) })
}

/* A twelve-month walk is a few hundred requests, so it can be paused by closing the page and picked up
 * again: the cursor lives in the store. Only a walk that has nothing pending restarts from page 1. */
function DeepScanButton({ sync }) {
  const paused = Number((sync || {}).page || 1) > 1
  return jsx('button', {
    type: 'button', style: { ...field, border: '1px solid ' + HAIRLINE },
    title: paused ? t('trend.deepResumeTitle', sync.page) : t('trend.deepTitle'),
    onClick: () => runSync({ days: 365, restart: !paused }),
    children: paused ? t('trend.deepResume') : t('trend.deep')
  })
}

function TrendTab() {
  const [days, setDays] = useState(30)
  const summary = useSummary(days)
  const year = useSummary(365)
  const data = (summary.data && summary.data.summary) || {}
  const byDate = data.days_by_date || []
  const dongRows = byDate.filter(r => Number(r.dong) > 0)
  const burn = Number(data.dong_per_day) || 0
  const tot = byDate.reduce((a, r) => {
    for (const k of ['tokens', 'tok_in', 'tok_out', 'tok_cache_read']) a[k] = (a[k] || 0) + (Number(r[k]) || 0)
    return a
  }, {})
  return jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
    jsxs('div', { style: gap, children: [7, 30, 90, 365].map(n => jsx('button', {
      type: 'button', onClick: () => setDays(n),
      style: { fontSize: 12, padding: '2px 10px', borderRadius: 999, cursor: 'pointer',
        background: days === n ? 'rgba(128,128,128,0.22)' : 'transparent', color: 'inherit', border: '1px solid transparent' },
      children: t('trend.days', n)
    }, n)) }),
    jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
      jsx(Stat, { label: t('trend.statCalls'), value: num(data.calls) }),
      jsx(Stat, { label: t('trend.statTokens'), value: tok(data.tokens),
        hint: t('trend.tokenHint', tok(tot.tok_in), tok(tot.tok_out), tok(tot.tok_cache_read)) }),
      jsx(Stat, { label: t('trend.statBilled'), value: dong(data.dong), hint: t('trend.billedHint') }),
      jsx(Stat, { label: t('trend.statEstimate'), value: est(data.usd_estimated), hint: t('trend.estHint') }),
      jsx(Stat, { label: t('trend.statAvgDay'), value: dong(burn),
        hint: burn > 0 ? t('trend.avgHint', dong(burn * 30)) : t('trend.noSpend') })
    ] }),
    burn > 0 && data.dong > 0 ? jsx('div', { style: faint,
      children: t('trend.burnLine', dong(burn), Math.round(data.dong / burn)) }) : null,
    jsx('div', { style: card, children: jsxs('div', { children: [
      jsxs('div', { style: { ...gap, justifyContent: 'space-between', marginBottom: 8 }, children: [
        jsx('div', { style: faint, children: t('trend.yearGrid', new Date().getFullYear()) }),
        jsx(DeepScanButton, { sync: (year.data || {}).sync })
      ] }),
      jsx(Calendar, { matrix: (year.data || {}).matrix || [], bill: (year.data || {}).bill })
    ] }) }),
    jsx('div', { style: card, children: jsxs('div', { children: [
      jsx('div', { style: { ...faint, marginBottom: 6 }, children: t('trend.dailyTitle', days) }),
      byDate.length ? jsx(Lines, { rows: byDate, series: [
        { key: 'dong', label: t('trend.seriesBilled'), format: dong },
        { key: 'tokens', label: t('trend.seriesTokens'), format: tok, color: 'var(--ui-success, #3fb27f)' }
      ] }) : jsx('div', { style: faint, children: t('common.emptyDays') })
    ] }) }),
    jsxs('div', { style: card, children: [
      jsx('div', { style: { ...faint, marginBottom: 8 }, children: t('trend.dailyDongTitle') }),
      dongRows.length ? jsx(Bars, { rows: dongRows.slice(-14), valueKey: 'dong', labelKey: 'day', format: dong })
        : jsx('div', { style: faint, children: t('trend.emptyBill') })
    ] }),
    jsxs('div', { style: card, children: [
      jsx('div', { style: { ...faint, marginBottom: 8 }, children: t('trend.latencyTitle') }),
      byDate.length ? jsx(Bars, { rows: byDate.slice(-14), valueKey: 'avg_ms', labelKey: 'day', format: v => Math.round(v) + 'ms' })
        : jsx('div', { style: faint, children: '—' })
    ] })
  ] })
}

/* ---------- shared table primitives ---------- */

/* A cell value for CSV: whatever the column would rather export than show. Render functions return
 * vnodes for links and tinted cells, and str() of a vnode is "[object Object]" -- so a column that
 * renders anything but text names its raw accessor. Falling back to the sort key is deliberate: it is
 * already the number behind the formatted string. */
function cellValue(c, r) {
  if (c.raw) return c.raw(r)
  const v = c.render(r)
  return typeof v === 'string' || typeof v === 'number' ? v : (c.sort ? c.sort(r) : '')
}

function csvOf(cols, rows) {
  const esc = v => {
    const s = String(v == null ? '' : v)
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return [cols.map(c => esc(c.label)).join(',')]
    .concat(rows.map(r => cols.map(c => esc(cellValue(c, r))).join(','))).join('\r\n')
}

/* Export writes through the host's download when there is one and through a blob link otherwise.
 * The page is a plugin route with no server side, so "export" is a client-side file, and the only
 * rows it can offer are the ones already loaded -- the title says so rather than implying "all". */
function ExportButton({ cols, rows, name, hint }) {
  const save = () => {
    const body = csvOf(cols, rows)
    const fname = (name || 'usage') + '-' + new Date().toISOString().slice(0, 10) + '.csv'
    try {
      const blob = new Blob(['' + body], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fname
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch (e) { /* no DOM download available: the table is still on screen */ }
  }
  return jsx('button', {
    type: 'button', onClick: save, disabled: !rows.length,
    title: hint || t('common.exportRows', rows.length),
    style: { ...field, border: '1px solid ' + HAIRLINE, opacity: rows.length ? 1 : 0.45 },
    children: t('common.exporting')
  })
}

function nextSort(cur, col) {
  if (!cur || cur.label !== col) return { label: col, dir: -1 }
  if (cur.dir === -1) return { label: col, dir: 1 }
  return null
}

function sortRows(rows, cols, sort) {
  if (!sort) return rows
  const col = cols.find(c => c.label === sort.label)
  if (!col || !col.sort) return rows
  const sign = sort.dir === 1 ? 1 : -1
  return rows.map((r, i) => [r, i]).sort((a, b) => {
    const x = col.sort(a[0])
    const y = col.sort(b[0])
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign || (a[1] - b[1])
    return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y)) * sign || (a[1] - b[1])
  }).map(p => p[0])
}

/* Column template shared by header and body: one cell per column, so digits line up in a column
 * instead of drifting inside a flex row -- the tables looked aligned per row and misaligned as one.
 * v2 adds clickable headers (a column sorts when it names a sort accessor), a scrolling body with the
 * header pinned, and a shared empty node, so every table on the page behaves the same way. */
function Grid({ cols, rows, keyOf, sort, onSort, maxHeight = 560, empty }) {
  const [local, setLocal] = useState(null)
  const state = onSort ? sort : local
  const apply = (label) => {
    const next = nextSort(state, label)
    if (onSort) onSort(next)
    else setLocal(next)
  }
  const shown = onSort ? rows : sortRows(rows, cols, state)
  const template = cols.map(c => c.width || 'auto').join(' ')
  const line = extra => ({ display: 'grid', gridTemplateColumns: template, gap: 10,
    padding: '5px 10px', ...extra })
  const head = jsx('div', { style: line({ padding: '2px 10px', position: 'sticky', top: 0, zIndex: 3,
      background: PANEL, backdropFilter: 'blur(6px)', borderBottom: '1px solid ' + HAIRLINE,
      scrollbarGutter: 'stable' }),
    children: cols.map(c => (c.sort ? jsx('button', {
      type: 'button', onClick: () => apply(c.label),
      title: t('common.sortBy', c.label),
      style: { ...faint, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer',
        textAlign: c.align || 'left', color: state && state.label === c.label ? ACCENT : INK_FAINT,
        background: 'transparent', border: 'none', padding: '4px 0', fontWeight: state && state.label === c.label ? 700 : 400 },
      children: c.label + (state && state.label === c.label ? (state.dir === 1 ? ' ▲' : ' ▼') : '')
    }, c.label) : jsx('span', { style: { ...faint, fontSize: 10, textTransform: 'uppercase',
      letterSpacing: '0.06em', textAlign: c.align || 'left' }, children: c.label }, c.label)))
  }, 'head')
  if (!shown.length) {
    return jsxs('div', { children: [head, jsx('div', {
      style: { ...faint, padding: '14px 10px' }, children: empty || t('common.none') }, 'empty')] }, 'grid')
  }
  return jsxs('div', { style: { maxHeight, overflowY: 'auto', overflowX: 'auto' }, children: [
    head,
    ...shown.map((r, i) => jsx('div', { style: line({ borderTop: '1px solid ' + HAIRLINE, fontSize: 12,
        color: INK, background: i % 2 ? 'transparent' : 'rgba(128,128,128,0.04)' }),
      children: cols.map(c => jsx('span', { className: (c.cls && c.cls(r)) || undefined,
        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          ...(c.num ? numCell : {}),
          ...(typeof c.style === 'function' ? (c.style(r) || {}) : (c.style || {})) },
        title: c.title ? String(c.title(r)) : undefined, children: c.render(r) }, c.label))
    }, keyOf ? keyOf(r, i) : i))
  ] }, 'grid')
}

/* The one message every "nothing here yet" branch used to write by hand, in three different wordings. */
function Empty({ children }) {
  return jsx('div', { style: { ...card, ...faint }, children: children })
}

function Err({ source, children }) {
  return jsxs('div', { style: { ...faint, color: 'var(--ui-error, #d9534f)' }, children: [
    children, source ? ' (' + String(source).slice(0, 90) + ')' : ''
  ] })
}

/* The key table is defined out of the component because the CSV export has to use the exact same
 * column list the table renders -- a second list would drift on the next edit and export the wrong
 * numbers under the right headers.
 *
 * A function, not a const: the labels come from the bundle, and a const list would evaluate them at
 * import -- before the first setLang -- which shows a Vietnamese reader English headers no matter what
 * their language setting says. */
function KEY_COLS() {
  return [
    { label: t('wallet.col.key'), width: '1fr', title: k => k.key_prefix,
      sort: k => String(k.name || k.key_prefix || ''), raw: k => (k.name || '?') + ' ' + (k.key_prefix || ''),
      render: k => (k.name || '?') + ' ' + (k.key_prefix || '') },
    { label: t('wallet.col.status'), width: '92px', sort: k => (k.active ? 0 : 2),
      raw: k => (k.active ? t('wallet.state.inUse') : (k.revoked_at ? t('wallet.state.revoked') : t('wallet.state.stopped'))),
      render: k => k.active ? t('wallet.state.inUse') : (k.revoked_at ? t('wallet.state.revoked') : t('wallet.state.stopped')) },
    { label: t('wallet.col.rpm'), width: '58px', align: 'right', num: true, sort: k => Number(k.rate_limit_rpm) || 0,
      render: k => num(k.rate_limit_rpm) },
    { label: t('wallet.col.calls'), width: '80px', align: 'right', num: true, sort: k => Number(k.total_requests) || 0,
      render: k => num(k.total_requests) },
    { label: t('wallet.col.models'), width: '62px', align: 'right', num: true, sort: k => Number(k.subscriptions) || 0,
      render: k => num(k.subscriptions) },
    { label: t('wallet.col.h24'), width: '86px', align: 'right', num: true, sort: k => Number(k._dong24) || 0,
      render: k => dong(k._dong24 || 0) },
    { label: t('wallet.col.spent'), width: '104px', align: 'right', num: true, sort: k => Number(k.total_spent) || 0,
      render: k => dong(Number(k.total_spent) || 0) }
  ]
}

function WalletTab() {
  const balance = useBalance(true)
  const snap = (balance.data && balance.data.balance) || {}
  const wallet = snap.wallet || {}
  /* vilao's per-key totals are lifetime; the 24 h column comes from the calls we have billed rows for. */
  const d24 = (balance.data && balance.data.per_key_24h) || {}
  const keys = (snap.keys || []).map(k => ({ ...k, _dong24: Number(d24[k.id]) || 0 }))
  const pending = snap.pending_topups || []
  const spent24 = Number((balance.data || {}).spent_24h) || 0
  const balanceValue = Number(wallet.balance) || 0
  const used = Number(wallet.used_balance) || 0
  const lifetime = balanceValue + used
  return jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
    jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
      jsx(Stat, { label: t('wallet.statLeft'), value: dong(balanceValue),
        hint: lifetime > 0 ? t('wallet.ofDeposited', pct(balanceValue / lifetime * 100)) : null }),
      jsx(Stat, { label: t('wallet.stat24h'), value: dong(spent24),
        hint: spent24 > 0 ? t('wallet.perWeek', dong(spent24 * 7)) : t('wallet.noSpend') }),
      jsx(Stat, { label: t('wallet.statSpent'), value: dong(used) }),
      jsx(Stat, { label: t('wallet.statDeposited'), value: dong(lifetime) }),
      jsx(Stat, { label: t('wallet.statWithdrawable'), value: dong(Number(wallet.withdrawable_balance) || 0) })
    ] }),
    balance.isError ? jsx('div', { style: faint, children: t('wallet.readFail', String(balance.error)) }) : null,
    balanceValue < 20000 ? jsxs('div', { style: { ...card, borderColor: 'currentColor' }, children: [
      jsx('strong', { children: t('wallet.lowTitle') }),
      jsx('div', { style: faint, children: t('wallet.lowBody', dong(balanceValue)) })
    ] }) : null,
    pending.length ? jsxs('div', { style: card, children: [
      jsx('div', { style: { ...faint, marginBottom: 6 }, children: t('wallet.pendingTitle') }),
      jsx(Grid, { cols: [
        { label: t('wallet.pendingCol.amount'), width: '110px', num: true,
          render: x => dong(Number(x.amount_expected) || 0) },
        { label: t('wallet.pendingCol.transaction'), width: '1fr', render: x => String(x.transaction_id || '') },
        { label: t('wallet.pendingCol.expires'), width: '140px', align: 'right', num: true,
          render: x => x.expires_at ? new Date(x.expires_at).toLocaleTimeString('vi-VN', { hour12: false }) : '—' }
      ], rows: pending, keyOf: x => x.transaction_id })
    ] }) : null,
    jsx('div', { style: card, children: jsxs('div', { children: [
      jsxs('div', { style: { ...gap, justifyContent: 'space-between', marginBottom: 6 }, children: [
        jsx('div', { style: faint, children: t('wallet.keysHeader') }),
        jsx(ExportButton, { cols: KEY_COLS(), rows: keys, name: 'vilao-keys', hint: t('wallet.exportKeys') })
      ] }),
      keys.length ? jsx(Grid, { cols: KEY_COLS(), rows: keys, keyOf: k => k.id || k.key_prefix,
        empty: t('wallet.noKeys') }) : jsx('div', { style: faint, children: '—' })
    ] }) }),
    jsx(Topups, {}),
    jsx('div', { style: faint, children: t('wallet.quotaNote') })
  ] })
}

/* ---------- quota ---------- */

/* The free tiers publish a request limit and say nothing about usage: no ``/usage`` route, no
 * ``x-ratelimit-*`` header on the response. The only meter that can exist is the one built from this
 * plugin's own call log, so the table reports what was measured and stops there. There is deliberately
 * no limit column: a comparison against a number nobody publishes would look like data. */
const QUOTA_WINDOWS = () => [{ value: '1', label: t('quota.window.h1') },
  { value: '24', label: t('quota.window.h24') }, { value: '168', label: t('quota.window.d7') }]

function PROVIDER_COLS() {
  return [
    { label: t('quota.col.provider'), width: 'minmax(150px, 1fr)', title: r => r.provider,
      sort: r => String(r.provider || ''), render: r => r.provider },
    { label: t('quota.col.calls'), width: '78px', align: 'right', num: true, sort: r => Number(r.calls) || 0,
      render: r => num(r.calls) },
    { label: t('quota.col.tokens'), width: '96px', align: 'right', num: true, sort: r => Number(r.tokens) || 0,
      render: r => tok(r.tokens) },
    { label: t('quota.col.billed'), width: '98px', align: 'right', num: true, sort: r => Number(r.dong) || 0,
      render: r => (Number(r.dong) ? dong(r.dong) : '—') },
    { label: t('quota.col.rpmNow'), width: '96px', align: 'right', num: true, sort: r => Number(r.rpm_now) || 0,
      render: r => num(r.rpm_now) },
    { label: t('quota.col.peakRpm'), width: '78px', align: 'right', num: true, sort: r => Number(r.peak_rpm) || 0,
      style: r => (Number(r.peak_rpm) >= 30 ? { className: HOT } : null), render: r => num(r.peak_rpm) },
    { label: t('quota.col.peakRph'), width: '78px', align: 'right', num: true, sort: r => Number(r.peak_rph) || 0,
      render: r => num(r.peak_rph) },
    { label: t('quota.col.errors'), width: '56px', align: 'right', num: true, sort: r => Number(r.errors) || 0,
      style: r => (r.errors > 0 ? { className: HOT } : null), render: r => (r.errors ? String(r.errors) : '—') },
    { label: t('quota.col.last'), width: '132px', align: 'right', num: true, style: () => faint,
      sort: r => Number(r.last_ts) || 0, raw: r => (r.last_ts ? longOf(r.last_ts) : ''),
      render: r => (r.last_ts ? longOf(r.last_ts) : '—') }
  ]
}

function QuotaTab() {
  const [hours, setHours] = useState('24')
  const rate = useRate(Number(hours))
  const rows = (rate.data || {}).by_provider || []
  const overall = (rate.data || {}).overall || {}
  return jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
    jsxs('div', { style: { ...gap, flexWrap: 'wrap' }, children: [
      jsx(Segmented, { options: QUOTA_WINDOWS(), value: hours, onChange: setHours }),
      jsx('span', { style: faint, children: t('quota.note') })
    ] }),
    rate.isError ? jsx('div', { style: faint, children: t('quota.readFail', String(rate.error)) }) : null,
    jsx('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
      jsx(Stat, { label: t('quota.statWindowCalls'), value: num(overall.calls) }, 'a'),
      jsx(Stat, { label: t('quota.statTokens'), value: tok(overall.tokens) }, 'b'),
      jsx(Stat, { label: t('quota.statPeakMinute'), value: t('quota.perMinute', num(overall.peak_rpm)) }, 'c'),
      jsx(Stat, { label: t('quota.statPeakHour'), value: t('quota.perHour', num(overall.peak_rph)) }, 'd'),
      jsx(Stat, { label: t('quota.statCharged'), value: dong(overall.dong) }, 'e')
    ] }),
    rows.length ? jsx('div', { style: { ...card, padding: '6px 0' }, children: jsxs('div', { children: [
      jsxs('div', { style: { ...gap, justifyContent: 'flex-end', padding: '0 10px 4px' }, children: [
        jsx(ExportButton, { cols: PROVIDER_COLS(), rows, name: 'providers' })
      ] }),
      jsx(Grid, { cols: PROVIDER_COLS(), rows, keyOf: r => r.provider,
        empty: t('quota.empty') })
    ] }) }) : jsx(Empty, { children: t('quota.empty') })
  ] })
}

/* ---------- vilao console, inside the page ---------- */

/* Catalogue prices arrive as dong per 1,000,000 tokens (verified against a measured charge), which is
 * the only way they are comparable; a promo row shows the old price struck through rather than
 * replacing it, because the discount is what the console is advertising. */
function priceCell(v, promo) {
  if (v == null) return jsx('span', { style: faint, children: '—' })
  const off = Number(promo) || 0
  return jsxs('span', { style: numCell, children: [
    off > 0 ? jsx('s', { style: { ...faint, marginRight: 5 }, children: dong(v) }) : null,
    String(dong(off > 0 ? v * (1 - off / 100) : v)), '/1M'
  ] })
}

/* A plugin that wants the system browser rather than a navigation inside the app asks the SDK, which
 * answers with a result instead of an exception: `false` means this shell refused the URL.
 *
 * The URL comes from the marketplace API, so it is checked here as well as at the source: https, and a
 * host the console actually is. Handing an arbitrary string to the OS shell is how a field that today
 * holds a model slug could tomorrow hold something else -- and the check runs first, so a refused URL
 * never reaches any door, fallback included. */
const ALLOWED_LINK_HOSTS = ['vilao.ai', 'www.vilao.ai']

function safeExternal(url) {
  let u
  try {
    u = new URL(String(url))
  } catch (e) {
    return null
  }
  if (u.protocol !== 'https:' || ALLOWED_LINK_HOSTS.indexOf(u.hostname.toLowerCase()) < 0) return null
  return u.href
}

function openInNewTab(safe) {
  if (typeof window !== 'undefined' && window.open) window.open(safe, '_blank', 'noopener')
}

function openExternal(url) {
  const safe = safeExternal(url)
  if (!safe) return
  if (!osOpen) {
    openInNewTab(safe)
    return
  }
  Promise.resolve(osOpen(safe)).then(ok => {
    if (ok === false) openInNewTab(safe)
  }, () => openInNewTab(safe))
}

const MODELS_PER = 100
/* Dong per 1,000,000 billed tokens, from the invoice rather than the price list. Returns null when the
 * row has no billed mass: the page would otherwise print a number that means "nothing measured". */
/* The price watch names the field that moved instead of averaging the offer's prices into one number:
 * a list-price cut and a cache-price rise are different decisions to make about an offer. */
/* Machine key to reader's word. A key neither bundle labels comes back as itself: an unlabelled field is
 * a payload this page has not been told about, and 'in' on screen beats the lookup path or a blank. */
function fieldName(f) {
  const key = 'models.field.' + f
  const label = t(key)
  return label === key ? String(f) : label
}

function priceDelta(m) {
  const chg = (m && m.chg) || []
  if (!chg.length) return '—'
  const first = chg.find(c => c.kind === 'price')
  if (!first) return chg[0].kind === 'new' ? t('models.price.newListed') : t('models.price.delisted')
  const pct = Number(first.pct) || 0
  return t('models.price.move', (pct > 0 ? '+' : '') + Math.round(pct) + '%', fieldName(first.field))
}

function effectivePrice(m) {
  const mine = m && m.mine
  if (!mine) return null
  const billed = Number(mine.tok_billed) || 0
  const dongPaid = Number(mine.dong) || 0
  if (!billed || !dongPaid) return null
  return dongPaid / billed * 1000000
}

/* Price after promo, in dong/1M -- the number a sort or a CSV has to use, because the cell shows two
 * prices (struck-through list and net) and only one of them is what the invoice charges. An offer with
 * no price has to come back as null, not 0: Number(null) is 0, which would sort an unpriced offer as
 * the cheapest thing on the marketplace. */
function netPrice(m, field) {
  const raw = m[field]
  if (raw === null || raw === undefined || raw === '') return null
  const v = Number(raw)
  if (!isFinite(v)) return null
  const off = Number(m.promo_off) || 0
  return off > 0 ? v * (1 - off / 100) : v
}

function MODEL_COLS() {
  return [
    { label: t('models.col.model'), width: 'minmax(140px, 1.2fr)', title: m => m.name + (m.seller ? ' · ' + m.seller : ''),
      sort: m => String(m.id || ''), raw: m => m.id, render: m => m.id },
    { label: t('models.col.provider'), width: 'minmax(96px, 150px)',
      sort: m => String(m.provider_name || m.provider || ''), raw: m => m.provider_name || m.provider || '',
      render: m => m.provider_name || m.provider || '—' },
    { label: t('models.col.kind'), width: '76px', hide: true, style: () => faint, sort: m => String(m.kind || ''),
      raw: m => m.kind || '', render: m => m.kind || '—' },
    { label: t('models.col.context'), width: '78px', align: 'right', num: true, sort: m => Number(m.context) || 0,
      raw: m => m.context || '', render: m => (m.context ? tok(m.context) : '—') },
    { label: t('models.col.priceIn'), width: '116px', sort: m => (netPrice(m, 'in') == null ? -1 : netPrice(m, 'in')),
      raw: m => (netPrice(m, 'in') == null ? '' : netPrice(m, 'in')), render: m => priceCell(m.in, m.promo_off) },
    { label: t('models.col.priceOut'), width: '116px', sort: m => (netPrice(m, 'out') == null ? -1 : netPrice(m, 'out')),
      raw: m => (netPrice(m, 'out') == null ? '' : netPrice(m, 'out')), render: m => priceCell(m.out, m.promo_off) },
    { label: t('models.col.cacheRead'), width: '112px', hide: true,
      sort: m => (netPrice(m, 'cache_read') == null ? -1 : netPrice(m, 'cache_read')),
      raw: m => (netPrice(m, 'cache_read') == null ? '' : netPrice(m, 'cache_read')),
      render: m => priceCell(m.cache_read, null) },
    { label: t('models.col.floor'), width: '72px', hide: true, align: 'right', num: true, sort: m => Number(m.floor) || 0,
      raw: m => (m.floor == null ? '' : m.floor), render: m => (m.floor == null ? '—' : dong(m.floor)) },
    { label: t('models.col.success'), width: '82px', align: 'right', num: true,
      sort: m => (m.success_rate == null ? -1 : Number(m.success_rate)),
      raw: m => (m.success_rate == null ? '' : m.success_rate),
      style: m => (m.success_rate != null && m.success_rate < 95 ? { className: HOT } : null),
      title: m => t('models.col.latency', m.latency_ms ? Math.round(m.latency_ms) + 'ms' : '—',
        m.requests ? num(m.requests) : 0),
      render: m => (m.success_rate == null ? '—' : m.success_rate.toFixed(1) + '%') },
    { label: t('models.col.callsMine'), width: '86px', align: 'right', num: true,
      sort: m => Number(m.mine && m.mine.calls) || 0, raw: m => Number(m.mine && m.mine.calls) || 0,
      style: m => (m.mine ? { fontWeight: 600, color: INK } : faint),
      render: m => (m.mine ? tok(m.mine.calls) : '—') },
    { label: t('models.col.paidMine'), width: '96px', align: 'right', num: true,
      sort: m => Number(m.mine && m.mine.dong) || 0, raw: m => Number(m.mine && m.mine.dong) || 0,
      render: m => (m.mine ? dong(m.mine.dong) : '—') },
    /* Effective price: what the invoice says per 1M billed tokens, against the list price of this
     * offer. The denominator is the billing shape (in + out + cache read) because that is what vilao
     * charges on -- using the local tok_total would inflate the figure by exactly the cached share.
     * A row that has no billed tokens, or no dong, has no answer here, so it shows a dash rather
     * than a division by zero dressed up as a price. */
    { label: t('models.col.effective'), width: '116px', align: 'right', num: true,
      sort: m => {
        const eff = effectivePrice(m)
        return eff == null ? -1 : eff
      },
      raw: m => {
        const eff = effectivePrice(m)
        return eff == null ? '' : Math.round(eff)
      },
      title: m => (m.mine && m.mine.tok_billed
        ? t('models.col.billedOf', dong(m.mine.dong), num(m.mine.tok_billed))
        : t('models.col.noPriceData')),
      style: m => {
        const eff = effectivePrice(m)
        if (eff == null) return faint
        const list = Number(netPrice(m, 'in')) || 0
        return list && eff > list * 1.2 ? { className: HOT } : { color: INK }
      },
      render: m => {
        const eff = effectivePrice(m)
        return eff == null ? '—' : dong(eff)
      } },
    { label: t('models.col.change'), width: '104px', align: 'right', num: true,
      sort: m => (m.chg ? Math.max(...m.chg.map(c => Math.abs(Number(c.pct) || 0))) : -1),
      raw: m => (m.chg || []).map(c => fieldName(c.field) + ':' + (c.pct == null ? c.kind : Math.round(c.pct) + '%'))
        .join(' '),
      title: m => t('models.col.changeHead') + '\n'
        + (m.chg || []).map(c => c.kind === 'new' ? t('models.col.newOffer')
          : c.kind === 'gone' ? t('models.col.goneOffer')
            : t('models.col.changeLine', fieldName(c.field), dong(Math.round(c.from)),
              dong(Math.round(c.to)),
              (c.pct > 0 ? '+' : '') + Math.round(c.pct) + '%')).join('\n'),
      style: m => (m.chg ? { color: ACCENT, fontWeight: 600 } : faint),
      render: m => priceDelta(m) },
    { label: t('models.col.open'), width: '54px', align: 'right', sort: m => (m.url ? 0 : 1), raw: m => m.url || '',
      render: m => m.url ? jsx('a', {
        href: m.url, target: '_blank', rel: 'noreferrer', title: m.url,
        onClick: e => { e.preventDefault(); openExternal(m.url) },
        style: { fontSize: 11, color: ACCENT, textDecoration: 'none', whiteSpace: 'nowrap' },
        children: t('models.link') }) : jsx('span', { style: faint, children: '—' }) }
  ]
}

/* Which columns are hidden is a preference, not a layout bug: the offer table is 14 columns wide and
 * the default view drops the three nobody compares by eye. Persisted through the host's own plugin
 * storage door rather than localStorage, because that is the surface the app guarantees a plugin can
 * write, and the one that scopes the value to this plugin. */
const COLS_PREF = 'models-cols'

let pref = null

function prefGet(key, fallback) {
  if (!pref) return fallback
  try {
    const v = pref.get(key, fallback)
    return v === undefined || v === null ? fallback : v
  } catch (e) {
    return fallback
  }
}

function prefSet(key, value) {
  if (!pref) return
  try {
    pref.set(key, value)
  } catch (e) {
    /* storage unavailable -- the choice then lasts the session, which is what it did before it persisted */
  }
}

function useHiddenCols(cols) {
  const [hidden, setHidden] = useState(() => {
    const stored = prefGet(COLS_PREF, null)
    const list = Array.isArray(stored) ? stored : (typeof stored === 'string' ? safeJson(stored) : null)
    return new Set(Array.isArray(list) ? list : cols.filter(c => c.hide).map(c => c.label))
  })
  const toggle = label => setHidden(prev => {
    const next = new Set(prev)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    prefSet(COLS_PREF, Array.from(next))
    return next
  })
  return { hidden, toggle }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

function ColsMenu({ cols, hidden, toggle }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const away = e => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    const key = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return jsx('div', { ref: box, style: { position: 'relative' }, children: jsxs('div', { children: [
    jsx('button', { type: 'button', onClick: () => setOpen(v => !v), 'aria-expanded': open,
      style: { ...field, border: '1px solid ' + HAIRLINE },
      title: t('common.colsTitle'),
      children: t('common.colsShown', cols.length - hidden.size) }, 'btn'),
    open ? jsx('div', { style: { position: 'absolute', zIndex: 30, right: 0, top: '100%', marginTop: 4,
        padding: 6, borderRadius: 8, background: PANEL, border: '1px solid ' + EDGE, minWidth: 190,
        boxShadow: '0 10px 28px rgba(0,0,0,0.35)', display: 'grid', gap: 2 },
      children: cols.map(c => jsxs('label', { style: { ...gap, gap: 8, fontSize: 12, cursor: 'pointer',
          padding: '3px 6px', borderRadius: 6, color: INK },
        children: [
          jsx('input', { type: 'checkbox', checked: !hidden.has(c.label), onChange: () => toggle(c.label) }),
          jsx('span', { children: c.label })
        ] }, c.label)) }) : null
  ] }) })
}

function ModelsTab() {
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('')
  const [sort, setSort] = useState({ label: t('models.col.callsMine'), dir: -1 })
  const [movedOnly, setMovedOnly] = useState(false)
  const page = useValue($modelsPage)
  const setPage = p => $modelsPage.set(p)
  const cat = useCatalog(search)
  /* Built once per render: the hidden set, the header menu and the export all have to agree on the same
   * list, and the labels are the only thing that keys them. */
  const allCols = MODEL_COLS()
  const { hidden, toggle } = useHiddenCols(allCols)
  const cols = allCols.filter(c => !hidden.has(c.label))
  const all = (((cat.data || {}).models) || [])
  const providers = useMemo(() => {
    const acc = new Map()
    for (const m of all) {
      const key = m.provider || '?'
      const item = acc.get(key) || { value: key, label: m.provider_name || key, n: 0 }
      item.n += 1
      acc.set(key, item)
    }
    return Array.from(acc.values()).sort((a, b) => b.n - a.n)
  }, [all])
  /* Sorted before the slice, not after: sorting the page in place would offer "the 10 cheapest offers
   * on page 3", which is not the same question and reads as if it were. */
  const rows = useMemo(() => {
    let filtered = provider ? all.filter(m => m.provider === provider) : all.slice()
    if (movedOnly) filtered = filtered.filter(m => m.chg)
    return sortRows(filtered, MODEL_COLS(), sort)
  }, [all, provider, sort, movedOnly])
  const pages = Math.max(1, Math.ceil(rows.length / MODELS_PER))
  const current = Math.min(page, pages)
  const slice = rows.slice((current - 1) * MODELS_PER, current * MODELS_PER)
  const mine = rows.filter(r => r.mine).length
  /* Counted from the provider-filtered set, not from `rows`: once the toggle is on, rows only holds the
   * changed offers, and a control that reads "price changes · 0" while showing 40 rows is
   * self-contradictory. */
  const changed = useMemo(
    () => all.filter(m => m.chg && (!provider || m.provider === provider)),
    [all, provider])
  const watchDay = ((((cat.data || {}).watch || {}).days || [])[1] || '').slice(8).replace('-', '/')
    || t('models.watchFallback')
  return jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
    jsxs('div', { style: { ...gap, flexWrap: 'wrap' }, children: [
      jsx('input', { style: { ...field, minWidth: 210, cursor: 'text' }, placeholder: t('models.search'),
        'data-usage-search': 'models', value: search,
        onChange: e => { setSearch(e.target.value); setPage(1) } }),
      jsx(Pick, { label: t('models.pickProvider'), value: provider, width: 210,
        options: [{ value: '', label: t('models.providerAll', all.length) },
          ...providers.map(p => ({ value: p.value, label: p.label, meta: t('models.offerMeta', p.n) }))],
        onChange: v => { setProvider(v); setPage(1) } }),
      jsx('span', { style: faint, children: cat.isFetching
        ? t('models.reading')
        : t('models.selling', rows.length, new Set(rows.map(r => r.id)).size, mine) }),
      /* The watch is the part a price list cannot do without memory: the store kept yesterday's snapshot
       * of the same offer, so "what moved since you last looked" is a fact here, not a guess. */
      changed.length ? jsxs(Choice, { on: movedOnly,
        onClick: () => { setMovedOnly(v => !v); setPage(1) },
        children: [jsx('span', { children: t('models.moved', changed.length) }),
          jsx('span', { style: faint, children: t('models.since', watchDay) })] }) : null,
      cat.data && cat.data.error ? jsx('span', { style: faint, children: String(cat.data.error).slice(0, 90) }) : null,
      jsx('button', { type: 'button', style: { ...field, border: '1px solid ' + HAIRLINE },
        title: t('models.refreshTitle'),
        onClick: () => queryClient && queryClient.invalidateQueries(CATALOG_KEY), children: t('models.refresh') })
    ] }),
    cat.isError ? jsx(Err, { source: 'models', children: t('models.readFail') }) : null,
    jsxs('div', { style: { ...card, padding: 0 }, children: [
      jsxs('div', { style: { ...gap, justifyContent: 'space-between', flexWrap: 'wrap',
          padding: '6px 10px 0' }, children: [
        jsx('div', { style: { ...faint, fontSize: 10 }, children: t('models.offerNote') }),
        jsxs('div', { style: { ...gap, gap: 6 }, children: [
          jsx(ColsMenu, { cols: allCols, hidden, toggle }),
          jsx(ExportButton, { cols, rows, name: 'vilao-catalog', hint: t('models.exportOffers', rows.length) })
        ] })
      ] }),
      rows.length ? jsx(Grid, { cols, rows: slice, sort, onSort: setSort,
        keyOf: m => m.key || (m.provider + '/' + m.id), maxHeight: 620,
        empty: t('models.empty') }) : jsx('div', { style: { ...faint, padding: 10 },
        /* Two different nothings. A failed read of the public price list is this page's problem; blame
         * the reader's filters for it and they go hunting for a filter they never set. */
        children: cat.isFetching ? t('models.loading')
          : cat.isError || (cat.data && cat.data.error) ? t('models.noOffers') : t('models.empty') }),
      jsx(Pager, { data: { total: rows.length, page: current, pages, per: MODELS_PER }, onPage: setPage })
    ] })
  ] })
}

function until(iso) {
  if (!iso || String(iso).startsWith('0001')) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (!isFinite(ms) || ms < 0) return t('time.overdue')
  const days = Math.floor(ms / 86400000)
  const hrs = Math.floor((ms % 86400000) / 3600000)
  return days > 0 ? t('time.daysHours', days, hrs) : hrs + 'h'
}

function KeysTab() {
  const keys = useKeys(true)
  const rows = (keys.data && keys.data.keys) || []
  const [picked, setPicked] = useState('')
  const active = picked || (rows.find(k => k.active) || rows[0] || {}).id || ''
  const detail = useKeyDetail(active)
  const k = (detail.data || {}).key || {}
  const book = ((detail.data || {}).models) || []
  const daily = until(k.daily_next_reset)
  const monthly = until(k.monthly_next_reset)
  return jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
    jsx('div', { style: { ...card, padding: '6px 0' }, children: rows.length ? jsx(Grid, { cols: [
      { label: t('keys.col.key'), width: 'minmax(140px, 1fr)', render: x => x.name || x.prefix },
      { label: t('keys.col.status'), width: '98px', style: x => (x.active ? { color: ACCENT, fontWeight: 600 } : faint),
        render: x => (x.active ? t('wallet.state.inUse') : x.revoked_at ? t('wallet.state.revoked') : t('wallet.state.stopped')) },
      { label: t('keys.col.rpm'), width: '58px', align: 'right', num: true, render: x => num(x.rpm) },
      { label: t('keys.col.models'), width: '68px', align: 'right', num: true, render: x => num(x.models) },
      { label: t('keys.col.totalCalls'), width: '88px', align: 'right', num: true, render: x => num(x.requests) },
      { label: t('keys.col.totalPaid'), width: '112px', align: 'right', num: true, render: x => dong(x.spent) },
      { label: t('keys.col.since'), width: '96px', align: 'right', num: true, style: faint,
        render: x => (x.created_at ? String(x.created_at).slice(0, 10) : '—') },
      { label: '', width: '78px', render: x => jsx(Choice, { on: x.id === active, wide: true,
        onClick: () => setPicked(x.id), children: t('keys.col.detail') }) }
    ], rows, keyOf: x => x.id }) : jsx('div', { style: faint, children: t('keys.readFail') }) }),
    active ? jsxs('div', { style: card, children: [
      jsxs('div', { style: { ...gap, justifyContent: 'space-between', marginBottom: 8 }, children: [
        jsxs('strong', { children: [String(k.name || 'key'), ' ', jsx('span', { style: faint,
          children: String(k.prefix || '') })] }),
        jsx('button', { type: 'button', style: { ...field, border: '1px solid ' + HAIRLINE },
          onClick: () => queryClient && queryClient.invalidateQueries(DETAIL_KEY), children: t('keys.reload') })
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
        jsx(Stat, { label: t('keys.statDayBudget'), value: k.daily_budget ? dong(k.daily_budget) : t('keys.notSet'),
          hint: daily ? t('keys.resetIn', daily) : t('keys.noResetDate') }),
        jsx(Stat, { label: t('keys.statMonthBudget'), value: k.monthly_budget ? dong(k.monthly_budget) : t('keys.notSet'),
          hint: monthly ? t('keys.resetIn', monthly) : null }),
        jsx(Stat, { label: t('keys.statCalls'), value: num(k.requests) }),
        jsx(Stat, { label: t('keys.statPaid'), value: dong(k.spent), hint: t('keys.lifetimeHint') })
      ] }),
      jsx('div', { style: { ...faint, marginTop: 8 }, children: t('keys.budgetNote') }),
      jsx('div', { style: { marginTop: 10 }, children: book.length ? jsx(Grid, { cols: [
        { label: t('keys.bookCol.model'), width: 'minmax(150px, 1fr)', render: m => m.model },
        { label: t('models.col.priceIn'), width: '112px', render: m => priceCell(m.in, m.promo_off) },
        { label: t('models.col.priceOut'), width: '112px', render: m => priceCell(m.out, m.promo_off) },
        { label: t('keys.bookCol.floor'), width: '98px', align: 'right', num: true,
          render: m => (m.floor == null ? '—' : dong(m.floor)) },
        { label: t('keys.bookCol.calls'), width: '72px', align: 'right', num: true, render: m => num(m.requests) },
        { label: t('keys.bookCol.dong'), width: '98px', align: 'right', num: true, render: m => dong(m.spent) },
        { label: t('keys.bookCol.tokens'), width: '86px', align: 'right', num: true, render: m => tok(m.tokens) },
        { label: t('keys.bookCol.health'), width: '88px', style: m => (m.health && m.health !== 'healthy' ? { color: INK } : faint),
          render: m => m.health || '—' }
      ], rows: book.slice().sort((a, b) => (b.spent || 0) - (a.spent || 0)), keyOf: m => m.model })
        : jsx('div', { style: faint, children: t('keys.noBook') }) })
    ] }) : null
  ] })
}

function Topups() {
  const top = useTopups()
  const rows = (top.data && top.data.transactions) || []
  const acct = (top.data || {}).account || {}
  const about = [acct.role ? t('wallet.topupRole', acct.role) : null,
    acct.created_at ? t('wallet.topupOpened', String(acct.created_at).slice(0, 10)) : null,
    acct.last_activity_at ? t('wallet.topupActive', String(acct.last_activity_at).slice(0, 16).replace('T', ' ')) : null]
    .filter(Boolean).join(' · ')
  return jsxs('div', { style: card, children: [
    jsxs('div', { style: { ...gap, justifyContent: 'space-between', marginBottom: 6 }, children: [
      jsx('div', { style: faint,
        children: t('wallet.topupTitle', (top.data || {}).paid_total ? dong(top.data.paid_total) : '—') }),
      acct.username ? jsx('span', { style: faint, title: acct.email || '',
        children: t('wallet.topupAccount', acct.username, about) }, 'acct') : null
    ] }),
    rows.length ? jsx(Grid, { cols: [
      { label: t('wallet.topupCol.amount'), width: '104px', align: 'right', num: true, render: x => dong(x.paid || x.expected) },
      { label: t('wallet.topupCol.status'), width: '96px', style: x => (x.status === 'paid' ? { color: ACCENT } : faint),
        render: x => (x.status === 'paid' ? t('wallet.topupState.paid')
          : x.status === 'pending' ? t('wallet.topupState.pending') : x.status || '—') },
      { label: t('wallet.topupCol.method'), width: '110px', render: x => x.method || '—' },
      { label: t('wallet.topupCol.created'), width: '150px', align: 'right', num: true, style: faint,
        render: x => (x.created_at ? String(x.created_at).slice(0, 16).replace('T', ' ') : '—') },
      { label: t('wallet.topupCol.credited'), width: '150px', align: 'right', num: true,
        render: x => (x.paid_at ? String(x.paid_at).slice(0, 16).replace('T', ' ') : '—') }
    ], rows, keyOf: x => x.id })
      : jsx('div', { style: faint, children: top.isLoading ? t('common.loading') : t('wallet.topupFail') })
  ] })
}

/* Every model Hermes has touched, from the call log rather than from the bill. This is the tab that
 * covers the free tiers: NVIDIA, OpenCode Zen and Kilo never appear in a vilao invoice, so a bill-driven
 * view cannot see them at all, while the log already holds their tokens, delays and error counts.
 *
 * It replaces the old Providers tab, which was the same model rollup restricted to billed dong -- and
 * therefore blank for exactly the providers worth looking at. */
const LOG_WINDOWS = () => [{ value: '30', label: t('log.window.m1') },
  { value: '90', label: t('log.window.m3') }, { value: '365', label: t('log.window.y1') }]

/* Both Log-tab tables are defined outside the component so the CSV export can use the identical column
 * list the screen does, and so each sort accessor sits next to the render it has to agree with. They are
 * functions for the same reason as the other column lists: labels have to be built after setLang. */
function SESSION_COLS() {
  return [
    { label: t('log.sessCol.session'), width: 'minmax(120px, 1fr)', title: s => String(s.session_id || ''),
      sort: s => String(s.session_id || ''), raw: s => s.session_id, render: s => shortSession(s.session_id) },
    { label: t('log.sessCol.home'), width: 'minmax(80px, 120px)', style: () => faint, sort: s => String(s.profile || ''),
      raw: s => s.profile || '', render: s => s.profile || '—' },
    { label: t('log.sessCol.platform'), width: '64px', style: () => faint, sort: s => String(s.platform || ''),
      raw: s => s.platform || '', render: s => s.platform || '—' },
    { label: t('log.sessCol.calls'), width: '62px', align: 'right', num: true, sort: s => Number(s.calls) || 0,
      render: s => num(s.calls) },
    { label: t('log.sessCol.models'), width: '62px', align: 'right', num: true, sort: s => Number(s.models) || 0,
      render: s => num(s.models) },
    { label: t('log.sessCol.tokens'), width: '86px', align: 'right', num: true, sort: s => Number(s.tokens) || 0,
      render: s => tok(s.tokens) },
    { label: t('log.sessCol.cache'), width: '76px', align: 'right', num: true, sort: s => Number(s.tok_cache) || 0,
      style: s => (Number(s.tokens) && Number(s.tok_cache) / Number(s.tokens) > 0.5 ? { color: ACCENT } : faint),
      render: s => tok(s.tok_cache) },
    { label: t('log.sessCol.billed'), width: '92px', align: 'right', num: true, sort: s => Number(s.dong) || 0,
      raw: s => Math.round(Number(s.dong) || 0), render: s => (Number(s.dong) ? dong(s.dong) : '—') },
    { label: t('log.sessCol.errors'), width: '50px', align: 'right', num: true, sort: s => Number(s.errors) || 0,
      style: s => (Number(s.errors) ? { className: HOT } : null), render: s => (s.errors ? num(s.errors) : '—') },
    { label: t('log.sessCol.span'), width: '76px', align: 'right', num: true, style: () => faint,
      sort: s => (Number(s.last_ts) || 0) - (Number(s.first_ts) || 0), raw: s => spanOf(s.first_ts, s.last_ts),
      title: s => t('log.sessCol.spanTitle', longOf(s.first_ts), longOf(s.last_ts)),
      render: s => spanOf(s.first_ts, s.last_ts) }
  ]
}

function LOG_MODEL_COLS() {
  return [
    { label: t('log.modelCol.model'), width: 'minmax(160px, 1fr)', title: m => t('log.modelCol.title', m.model_key),
      sort: m => String(m.model_key || ''), raw: m => m.model_key,
      render: m => jsx('button', {
        type: 'button',
        onClick: () => { $search.set(m.model_key); $mode.set('hermes'); $page.set(1); $tab.set('live') },
        style: { background: 'transparent', border: 'none', padding: 0, margin: 0, font: 'inherit',
          color: 'inherit', cursor: 'pointer', textAlign: 'left', maxWidth: '100%', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        children: shortModel(m.model_key) }) },
    { label: t('log.modelCol.provider'), width: 'minmax(110px, 150px)', style: faint, sort: m => String(m.providers || ''),
      raw: m => m.providers || '', render: m => m.providers || '—' },
    { label: t('log.modelCol.home'), width: 'minmax(90px, 130px)', style: faint, sort: m => String(m.profiles || ''),
      raw: m => m.profiles || '', render: m => m.profiles || '—' },
    { label: t('log.modelCol.calls'), width: '66px', align: 'right', num: true, sort: m => Number(m.calls) || 0,
      render: m => num(m.calls) },
    { label: t('log.modelCol.tokens'), width: '86px', align: 'right', num: true, sort: m => Number(m.tokens) || 0,
      render: m => tok(m.tokens) },
    { label: t('log.modelCol.cache'), width: '78px', align: 'right', num: true, sort: m => Number(m.tok_cache) || 0,
      style: m => (Number(m.tokens) && Number(m.tok_cache) / Number(m.tokens) > 0.5 ? { color: ACCENT } : faint),
      render: m => tok(m.tok_cache) },
    { label: t('log.modelCol.billed'), width: '92px', align: 'right', num: true, sort: m => Number(m.dong) || 0,
      raw: m => Math.round(Number(m.dong) || 0), render: m => (Number(m.dong) ? dong(m.dong) : '—') },
    { label: t('log.modelCol.estimate'), width: '84px', align: 'right', num: true, style: faint, sort: m => Number(m.usd) || 0,
      raw: m => Number(m.usd) || 0, title: m => estTitle(m.usd), render: m => est(m.usd) },
    { label: t('log.modelCol.errors'), width: '50px', align: 'right', num: true, sort: m => Number(m.errors) || 0,
      style: m => (Number(m.errors) ? { className: HOT } : null), render: m => (m.errors ? num(m.errors) : '—') },
    { label: t('log.modelCol.avgDelay'), width: '68px', align: 'right', num: true, sort: m => Number(m.avg_ms) || 0,
      raw: m => (m.avg_ms ? Math.round(m.avg_ms) : ''), render: m => (m.avg_ms ? Math.round(m.avg_ms) + 'ms' : '—') },
    { label: t('log.modelCol.days'), width: '74px', align: 'right', num: true, sort: m => Number(m.days) || 0,
      render: m => num(m.days) },
    { label: t('log.modelCol.last'), width: '132px', align: 'right', num: true, style: faint, sort: m => Number(m.last_ts) || 0,
      raw: m => (m.last_ts ? longOf(m.last_ts) : ''), render: m => (m.last_ts ? longOf(m.last_ts) : '—') }
  ]
}

function LogTab() {
  const [days, setDays] = useState('30')
  const profile = useValue($profile)
  const log = useLog(Number(days))
  const sessions = useSessions(Number(days))
  const daily = useSummary(Number(days), 'hook')
  const homes = useProfiles()
  const models = (log.data && log.data.models) || []
  const byDate = ((daily.data || {}).summary || {}).days_by_date || []
  const homeList = useMemo(() => homeOptions((homes.data && homes.data.profiles) || []), [homes.data])
  const byProfile = useMemo(() => {
    const acc = new Map()
    for (const m of models) {
      for (const h of String(m.profiles || '').split(',')) {
        if (!h) continue
        acc.set(h, (acc.get(h) || 0) + Number(m.calls || 0))
      }
    }
    return Array.from(acc, ([profile, calls]) => ({ profile, calls })).sort((a, b) => b.calls - a.calls)
  }, [models])
  const [sessSort, setSessSort] = useState({ label: t('log.sessCol.billed'), dir: -1 })
  const [modelSort, setModelSort] = useState({ label: t('log.modelCol.calls'), dir: -1 })
  const sessionRows = useMemo(
    () => sortRows((sessions.data && sessions.data.sessions) || [], SESSION_COLS(), sessSort),
    [sessions.data, sessSort])
  const modelRows = useMemo(() => sortRows(models, LOG_MODEL_COLS(), modelSort), [models, modelSort])
  const totals = models.reduce((a, m) => {
    a.calls += Number(m.calls) || 0
    a.tokens += Number(m.tokens) || 0
    a.dong += Number(m.dong) || 0
    a.errors += Number(m.errors) || 0
    return a
  }, { calls: 0, tokens: 0, dong: 0, errors: 0 })
  return jsxs('div', { style: { display: 'grid', gap: 12 }, children: [
    jsxs('div', { style: { ...gap, flexWrap: 'wrap' }, children: [
      jsx(Segmented, { options: LOG_WINDOWS(), value: days, onChange: setDays }),
      jsx(Pick, { label: 'home', value: profile, width: 210, options: homeList,
        onChange: v => $profile.set(v) }),
      jsx('span', { style: faint, children: t('log.source') })
    ] }),
    jsx('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
      jsx(Stat, { label: t('log.statCalls'), value: num(totals.calls) }, 'a'),
      jsx(Stat, { label: t('log.statTokens'), value: tok(totals.tokens) }, 'b'),
      jsx(Stat, { label: t('log.statModels'), value: num(models.length) }, 'c'),
      jsx(Stat, { label: t('log.statCharged'), value: dong(totals.dong), hint: t('log.chargedHint') }, 'd'),
      jsx(Stat, { label: t('log.statErrors'), value: num(totals.errors) }, 'e')
    ] }),
    jsx('div', { style: card, children: jsxs('div', { children: [
      jsx('div', { style: { ...faint, marginBottom: 6 },
        children: t('log.dailyTitle', days) }),
      byDate.length ? jsx(Lines, { rows: byDate, series: [
        { key: 'tokens', label: t('log.seriesTokens'), format: tok },
        { key: 'calls', label: t('log.seriesCalls'), format: num, color: 'var(--ui-success, #3fb27f)' },
        { key: 'tok_cache_read', label: t('log.seriesCache'), format: tok, color: 'var(--ui-warning, #d9a13b)' }
      ] }) : jsx('div', { style: faint, children: t('common.emptyDays') })
    ] }) }),
    byProfile.length ? jsx('div', { style: card, children: jsxs('div', { children: [
      jsx('div', { style: { ...faint, marginBottom: 6 }, children: t('log.byHomeTitle') }),
      jsx(Bars, { rows: byProfile, valueKey: 'calls', labelKey: 'profile', format: num })
    ] }) }) : null,
    /* Sessions, because the question when the wallet drops is "what did that run do", and a per-call log
     * of 100-row pages cannot answer it. Cache share is shown next to the tokens: it is what makes a long
     * conversation cheap or expensive. */
    (sessions.data && sessions.data.sessions) ? jsxs('div', { style: { ...card, padding: '6px 0' }, children: [
      jsx('div', { style: { ...gap, justifyContent: 'flex-end', padding: '0 10px' },
        children: jsx(ExportButton, { cols: SESSION_COLS(), rows: sessionRows, name: 'log-sessions' }) }),
      sessionRows.length ? jsx(Grid, { cols: SESSION_COLS(), rows: sessionRows,
        keyOf: s => String(s.session_id), sort: sessSort, onSort: setSessSort, maxHeight: 420 })
        : jsx('div', { style: { ...faint, padding: 10 }, children: t('log.emptySessions') }) ] }) : null,
    models.length ? jsxs('div', { style: { ...card, padding: '6px 0' }, children: [
      jsx('div', { style: { ...gap, justifyContent: 'flex-end', padding: '0 10px' },
        children: jsx(ExportButton, { cols: LOG_MODEL_COLS(), rows: modelRows, name: 'log-models' }) }),
      jsx(Grid, { cols: LOG_MODEL_COLS(), rows: modelRows, keyOf: m => m.model_key,
        sort: modelSort, onSort: setModelSort, maxHeight: 480 }) ] })
      : jsx(Empty, { children: t('log.emptyModels') })
  ] })
}

/* Keyboard, because this page is a browser over the whole call log and the mouse is the slowest
 * way to move through them: [ ] page, / focus the filter of the tab you are on, Esc close the open row,
 * 1-7 jump between tabs. No modifier is hijacked, and every key is inert while a field has focus --
 * typing "/" into a filter must stay a slash. */
function useHotkeys(tab) {
  useEffect(() => {
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      /* `tgt`, not `t`: the module-level message helper is `t`, and a local `t` here would silently
       * shadow it for any label this handler later needs. */
      const tgt = e.target
      const typing = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
      if (e.key === 'Escape') {
        if (typing) { tgt.blur(); return }
        $openRow.set(null)
        return
      }
      if (typing) return
      if (e.key === '[' || e.key === ']') {
        if (PAGER.go) { e.preventDefault(); PAGER.go(e.key === ']' ? 1 : -1) }
        return
      }
      if (e.key === '/') {
        const box = document.querySelector('[data-usage-search]')
        if (box) { e.preventDefault(); box.focus(); if (box.select) box.select() }
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= TABS.length && TABS[n - 1] !== tab) $tab.set(TABS[n - 1])
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tab])
}

function Page() {
  const tab = useValue($tab)
  const appLocale = useAppLocale()
  const settings = useSettings()
  const fx = useFx()
  const read = settings.data || {}
  /* Both resolved here, during render, before a single child is drawn: an effect would paint one frame of
   * English on a Vietnamese reader's machine and one frame of the wrong money unit on everyone else, and
   * a frame of the wrong language is the one thing a locale switch looks like a bug in. */
  setLang(resolve(appLocale, read.language))
  MONEY = { currency: read.currency || 'auto', rate: ((fx.data || {}).fx || {}).usd_vnd || null }
  useCallFeed()
  useFirstRunBackfill(Number(read.lookback_days) || 30)
  useHotkeys(tab)
  return jsxs('div', { style: { padding: 16, display: 'grid', gap: 12, alignContent: 'start', height: '100%', overflowY: 'auto' }, children: [
    jsxs('div', { style: { ...gap, justifyContent: 'space-between' }, children: [
      jsx('h1', { style: { fontSize: 18, fontWeight: 600, margin: 0 }, children: t('app.title') }),
      jsx('span', { style: faint, children: t('app.version', VERSION) })
    ] }),
    jsx(TabBar, {}),
    jsx(Banner, {}),
    tab === 'live' ? jsx(LiveTab, {}) : null,
    tab === 'trend' ? jsx(TrendTab, {}) : null,
    tab === 'log' ? jsx(LogTab, {}) : null,
    tab === 'wallet' ? jsx(WalletTab, {}) : null,
    tab === 'quota' ? jsx(QuotaTab, {}) : null,
    tab === 'keys' ? jsx(KeysTab, {}) : null,
    tab === 'models' ? jsx(ModelsTab, {}) : null,
    jsxs('div', { style: { ...faint, paddingTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }, children: [
      jsx('span', { children: rateLine((fx.data || {}).fx) }, 'fx'),
      jsx('span', { style: { marginLeft: 'auto' },
        children: t('app.keys') }, 'keys')
    ] })
  ] })
}

/* The doors this page needs from the host, captured once at registration. Each is feature-detected
 * because the renderer can be pointed at an older or remote host that has no such member; a door that is
 * absent degrades to its own fallback rather than failing the page. Named separately from register() so
 * the unit gate (tests/ui_units.mjs) can hand it a fake door and watch which way a link leaves. */
function bindDoors(ctx) {
  const os = (ctx && ctx.os) || null
  osOpen = os && typeof os.openExternal === 'function' ? os.openExternal.bind(os) : null
  try { rest = ctx.rest || null } catch (e) { rest = null }
  try { pref = ctx.storage || null } catch (e) { pref = null }
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: 'Per-model call log and cost charts: every provider Hermes called, with real dong from the vilao bill.',
  defaultEnabled: true,
  register(ctx) {
    bindDoors(ctx)
    /* ctx.i18n is built for every plugin (apps/desktop/src/contrib/plugin.ts), so the catch below covers
     * a remote or older host that has no such door, not the local case. */
    try {
      ctx.i18n && ctx.i18n.register({ en: LOCALE_EN, vi: LOCALE_VI })
    } catch (e) { /* no i18n door: the plugin's own resolver still renders English */ }
    const onDispose = typeof ctx.onDispose === 'function' ? fn => ctx.onDispose(fn) : () => {}
    onDispose(() => { rest = null })

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(Page, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 62, data: { path: ROUTE, label: PLUGIN_NAME, codicon: 'watch' } },
      { id: 'open', area: PALETTE_AREA, data: {
        id: 'call-ledger.open', label: 'Call Ledger: Open', keywords: ['usage', 'cost', 'ledger'],
        run: () => host.navigate(ROUTE)
      } },
      ...(KEYBINDS_AREA ? [{ id: 'open-key', area: KEYBINDS_AREA, data: {
        id: 'call-ledger.open', label: 'Open Call Ledger', category: PLUGIN_NAME, defaults: ['mod+alt+c'],
        run: () => host.navigate(ROUTE)
      } }] : [])
    ])
  }
}
