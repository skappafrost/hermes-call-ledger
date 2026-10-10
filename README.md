# Call Ledger (plugin id `hermes-call-ledger`, route `/call-ledger`)

> **Locally built, locally patched — nothing here comes from the catalog.** The store, the matcher and
> the page are all this machine's code. `desktop-plugins/hermes-call-ledger/` is a copy the app
> republishes from `desktop/`; edit the source, never the copy.

Per-model call log and cost charts for Hermes Desktop: every provider Hermes called, with the real dong
from the vilao bill attached to it.

## What the seven tabs are

| Tab | Question it answers | Route |
|---|---|---|
| **Live** | every call, newest first, filterable and paged (100/page) | `/calls` |
| **Trend** | which days cost what, and the year at a glance | `/summary?days=` (day rows + day×model matrix) |
| **Log** | what Hermes' own log says per model and per session, not only what vilao billed | `/log`, `/sessions` |
| **Quota** | measured request rate per provider (the free tiers publish no usage API) | `/rate` |
| **Wallet** | the vilao balance, per-key spending, top-up history | `/balance`, `/topups` |
| **Keys** | one consumer key's price book and usage | `/keys/detail` |
| **Models** | the whole marketplace, your own price beside each list price | `/catalog` |

Interactions worth knowing:

- **Keyboard** — `[` `]` page, `/` focus the filter, `1`-`7` switch tab, `Esc` close. Keys are inert
  while a field has focus, and no modifier is taken.
- **Click a header** to sort (numeric columns sort numerically; a second click reverses, a third clears).
  Sorting happens before paging, so "the 10 cheapest offers" means the ten cheapest, not ten of a page.
- **Click a year-grid square** to open the Live tab filtered to exactly that day. Clicking a model name
  filters the log to that model.
- **CSV** exports the column list the table is actually showing, for the rows the filter matched.
- **Columns** in the Models tab: three low-signal columns start hidden and the choice is remembered.
- **đổi giá** appears once the store holds two days of catalogue snapshots; it compares net prices
  (after promo) per offer, and reports offers that appeared or disappeared.

## Settings

Declared in `plugin.yaml` under `config_schema`, so they show up as form fields in the Desktop/TUI Plugins
hub and live at `plugins.entries.hermes-call-ledger.settings.<key>` in that home's `config.yaml`. The page
reads the first three through one route (`GET /settings`); unset keys answer with the default below, so a
fresh install paints English and dong rather than failing to paint.

| Key | Type | Default | What it changes |
|---|---|---|---|
| `language` | `auto` \| `en` \| `vi` | `auto` | The page's copy. `auto` follows the Desktop language (`useI18n`); a language with no bundle here falls back to English. |
| `currency` | `auto` \| `vnd` \| `usd` | `auto` | The money unit. `auto` is the billing feed's own dong. Crossing to dollars needs the FX rate; with no rate the cell prints `—`, never a figure the account did not charge. |
| `lookback_days` | int | `30` | The window the page reads and backfills when it first opens. |
| `vilao_pat` | **secret** (`env: VILAO_PAT`) | — | Read-only PAT for vilao.ai. It is stored in the home's `.env` by the app's credential route, never in `config.yaml`, and `/settings` refuses it by name so it cannot be echoed into the renderer. |

Two consequences worth knowing before you change any of this: the language and the money unit are applied
during `Page`'s render, not in an effect, because a frame of the wrong language looks like a bug in a
locale switch; and the two bundles are kept key-for-key by `tests/locale_parity.test.mjs`, so a new message
that only exists in English fails the gate instead of silently answering English to a Vietnamese reader.

## How the numbers stay honest

Two feeds land in one SQLite file (`<root>/plugin-data/call-ledger/calls.sqlite`, shared by every
profile home):

- `source='hook'` — Hermes' observer hooks: every provider, token shape as Hermes reports it
  (input + output), USD estimate from the internal price book.
- `source='bill'` — vilao's billing API: real dong, billed token shape (input + output + cache read).

`match_rows()` pairs a charge to a call by model key and nearest timestamp, and the dong then lives on
the *call* row. Consequences the code depends on:

- A đ/1M price must divide by the **billed** shape (`tok_in + tok_out + tok_cache`), not `tok_total`.
- The empty `profile` bucket is the billing feed, which belongs to the account, not to a home. The page
  labels it `hóa đơn`; `-` means "a row we cannot attribute".
- Never re-ingest a charge that already paired — the pair folds it into the call row, so the check is
  against `bill_request_id` on the call, not only the bill table.

## The rollups

`day_stats` (day × home × feed) and `day_model_stats` (day × home × feed × model) are derived tables,
rebuilt inside the same transaction as every write to `calls` (`touch_days`). Aggregates are stored raw
(`ms_sum`/`ms_n`, not an average) so re-grouping across days or models stays exact.

`rollup_consistent()` fingerprints `calls` (rows, billed dong, newest rowid — over the days the rollup
can describe) and `ensure_rollups()` rebuilds when they disagree, which is how a row written by an older
build or a crash between write and rebuild gets counted instead of silently missing. There is no memo:
the rollup *is* the cache, and reading it costs milliseconds for a year.

`catalog_prices` is the price watch — one row per (day, offer), written by `/catalog` when the
marketplace is read, pruned to `CATALOG_RETENTION_DAYS`.

## Traps this code has already been bitten by

1. Plugin modules load by **file path**: `from . import x` fails; import by the names the loader uses.
2. A pooled SQLite connection in legacy isolation mode serves the snapshot it read at startup forever —
   hence `isolation_level=None` plus explicit `BEGIN IMMEDIATE`.
3. An index over `date(ts,…)` cannot exist; the `day` column has to be stored, and any index on it must
   be created *after* `ALTER TABLE … ADD COLUMN day`, or a migrated store fails with `no such column`.
4. `children` belongs in the props object. `jsxs('div', {…}, [ … ])` puts the array in the **key** slot
   and renders an empty element — which is why the render harness asserts a marker string per tab.
5. A `HERMES_HOME` inside the install root resolves back to the root, so a probe run there writes into
   the live store. Use a temp home.
6. Bill replay can delete rows; a prune that does not rebuild the days it emptied leaves a Trend square
   that never fades.
7. Windows: an open SQLite handle blocks temp-dir deletion, so tests call `close_connections()`.
8. The console is cp1252; Vietnamese assertion text must survive `stdout.reconfigure(utf-8)`.

## Tests

```
py -3.13 -m pytest tests -q                # store, matcher, routes, identity and the two gates
py -3.13 tests/test_usage_page.py          # the same suite standalone
py -3.13 tests/dump_fixtures.py            # rebuild tests/fixtures.json from a throwaway home
node tests/render_plugin.mjs               # renders all 7 tabs and the Page, under en and under vi
node tests/ui_units.mjs                    # unit gate for the pure table helpers and the money printer
node --test tests/locale.test.mjs tests/locale_parity.test.mjs   # resolver, and the two bundles' parity
node tools/no_literal.mjs                  # no page copy outside the bundles, every t() key resolvable
```

`tests/dump_fixtures.py` writes `fixtures.json` from a temporary home seeded with synthetic rows, never
from a live store, so the harness sees the shapes the routes really return; `tests/render_plugin.mjs`
fails (exit 1) on a tab that renders `undefined`, `NaN`, `[object Object]`, none of its expected markers,
or the *other* locale's marker -- a header left in English under `vi` is caught there, not in review.

`.github/workflows/validate.yml` runs all of them on every push and pull request, against a shallow clone
of `NousResearch/hermes-agent` exported as `HERMES_AGENT_DIR`. That variable is how a test finds the host
(`tests/hermes_env.py`) and where the render harness borrows React; unset, both fall back to the install
on this machine, which is why CI sets it explicitly. Set it the same way before a local run if your
checkout is not the one Hermes installed.

The one gate CI does not run is `hermes plugins validate .`: it needs a provisioned Hermes environment,
and a plugin repo must not install one on a runner. The catalog's own CI runs it against the commit you
pin, so it belongs in your pre-push step, beside the commands above:

```
hermes plugins validate .                        # catalog admission checks, against your runtime
```

