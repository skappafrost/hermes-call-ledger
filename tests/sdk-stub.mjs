/** Stub of @hermes/plugin-sdk: enough of the real surface to render the page outside Electron.
 *
 * useQuery runs queryFn() synchronously against tests/fixtures.json, which tests/dump_fixtures.py builds
 * from a throwaway home seeded with synthetic rows -- so the components receive the shapes the routes
 * really return without any run ever reading a live store.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures.json'), 'utf-8'))

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'nav'
export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'
export const STATUSBAR_AREAS = { left: 'left', right: 'right' }

export const host = {
  onEvent: () => () => {},
  navigate: () => {},
  requestProfile: async () => ({}),
  t: k => k
}

export function atom(initial) {
  // a fresh object every call: two atoms seeded with the same value are still two atoms
  const a = { value: initial, get: () => a.value, set: v => { a.value = v }, listen: () => () => {} }
  return a
}

export function useValue(a) {
  return a && a.get ? a.get() : a
}

const failures = []
globalThis.__renderFailures = failures

function pick(path) {
  const p = String(path || '')
  if (process.env.RQ_DEBUG) console.log('  rest ->', p.slice(0, 40))
  if (p.startsWith('/keys/detail')) return FIXTURES.keyDetail
  if (p.startsWith('/keys')) return FIXTURES.keys
  if (p.startsWith('/catalog')) return FIXTURES.catalog
  if (p.startsWith('/topups')) return FIXTURES.topups
  if (p.startsWith('/log')) return p.includes('days=365') ? FIXTURES.logAll : FIXTURES.log
  if (p.startsWith('/sessions')) return FIXTURES.sessions
  if (p.startsWith('/rate')) return FIXTURES.rate
  if (p.startsWith('/summary')) {
    if (p.includes('days=365')) return FIXTURES.summary365
    return p.includes('source=hook') ? FIXTURES.summaryHook : FIXTURES.summary
  }
  if (p.startsWith('/profiles')) return FIXTURES.profiles
  if (p.startsWith('/balance')) return FIXTURES.balance
  if (p.startsWith('/health')) return FIXTURES.health
  if (p.startsWith('/fx')) return FIXTURES.fx
  if (p.startsWith('/calls')) {
    if (p.includes('billed=1')) return FIXTURES.vilaoCalls
    return p.includes('page=2') ? FIXTURES.callsPage2 : FIXTURES.calls
  }
  throw new Error('no fixture for ' + p)
}

export function useQuery(opts) {
  if (process.env.RQ_DEBUG) console.log('  useQuery', JSON.stringify(opts.queryKey).slice(0,60), 'enabled=', opts.enabled)
  if (opts.enabled === false) return { data: undefined, isError: false, isLoading: false, isFetching: false }
  try {
    return { data: opts.queryFn(), isError: false, isLoading: false, isFetching: false }
  } catch (err) {
    failures.push(String(opts.queryKey) + ': ' + err.message)
    return { data: undefined, isError: true, error: err, isLoading: false, isFetching: false }
  }
}

export const queryClient = {
  getQueryData: () => undefined,
  setQueryData: () => {},
  invalidateQueries: () => {},
  refetchQueries: () => {}
}

export function useQueryClient() {
  return queryClient
}

export const fixtureRest = path => pick(path)
