# Call Ledger

Call Ledger is a cost ledger for Hermes Desktop. Every model call Hermes makes — a turn, a compression
pass, a title or embedding side call, a request that failed — is recorded by three observer hooks into
one SQLite file, and the page answers the four questions a bill raises: which call, which model, which
day, which session. Each row carries the token split as Hermes reported it and a USD estimate from
Hermes' own price book. If your account has a billing provider that publishes a per-request ledger
(vilao.ai today, and it is optional), the amount actually charged is attached to the call that produced
it, and the two feeds are kept apart rather than averaged: every row says whether it came from the Hermes
log, from the bill, or was matched between the two. It installs as one Desktop route with seven tabs, in
English or Vietnamese, in dong or dollars.

![The live tab: the newest calls, their filters and the totals strip](docs/banner.png)

![Live: every call, newest first, paged and filterable](docs/live.png)

![Trend: a year as a grid, one square per day, shaded by what the day cost](docs/trend.png)

![Models: the marketplace offer list with the price you paid beside the list price](docs/models.png)

The seven tabs:

| Tab | Question it answers |
|---|---|
| Live | every call, newest first, filterable and paged server-side |
| Trend | which days cost what, and the year at a glance; click a square to open that day's log |
| Log | what Hermes' own log says per model and per session, not only what a bill charged |
| Quota | measured request rate per provider, counted from this plugin's own rows |
| Wallet | balance, per-key totals and top-up history (billing provider required) |
| Keys | one key's price book, limits and reset dates (billing provider required) |
| Models | the marketplace offer list, with what you paid per 1M billed tokens beside each list price |

## Install

Once it is in the Hermes plugin catalog:

```
hermes plugins install hermes-call-ledger
```

Until then, straight from the repository:

```
hermes plugins install https://github.com/skappafrost/hermes-call-ledger
```

Installing puts it on disk; loading it is a separate, per-profile decision. For each Hermes profile that
should record its calls:

```
hermes plugins enable hermes-call-ledger
```

which adds the id to `plugins.enabled` in that profile's `config.yaml`. An installed-but-not-enabled
plugin's Python is never imported by the backend — that is the host's own gate, not this plugin's choice.

Then restart the Desktop app once. The plugin's hooks and its backend routes are registered when the
Hermes backend that the app starts comes up, so an enable in the middle of a session is not guaranteed to
be live until the next start: sidebar entry, page and recording all arrive with it.

Open it from the sidebar (**Call Ledger**), from the command palette (`Call Ledger: Open`), or with
`Ctrl+Alt+C` (`Cmd+Alt+C` on macOS). Inside the page: `[` and `]` page, `/` focuses the filter, `1`-`7`
switch tab, `Esc` closes a popover. No modifier is taken and the keys are inert while a field has focus.

Needs Hermes 0.21 or newer. On an older Desktop the page still paints: every app-facing call it makes
(the i18n door, the locale hook, the external-link door) is guarded, and a missing door falls back to
English rather than to a blank tab.

## Configure

Four settings, declared in `plugin.yaml` under `config_schema`, which is what makes them form fields in
the Plugins hub (Desktop Settings → Plugins, and the same schema the TUI reads). They live at
`plugins.entries.hermes-call-ledger.settings.<key>` in that home's `config.yaml`; editing the file by
hand is equivalent.

| Key | Values | Default | What it changes |
|---|---|---|---|
| `language` | `auto` \| `en` \| `vi` | `auto` | The page's copy. `auto` follows the Desktop app's own language; `en` or `vi` forces this plugin's bundle. English is the fallback whenever a bundle has no such language. |
| `currency` | `auto` \| `vnd` \| `usd` | `auto` | The money unit. `auto` is the billing feed's own currency when one is configured, otherwise the converted estimate. |
| `lookback_days` | int | `30` | How far the deep bill walk reads when the page first opens. |
| `vilao_pat` | secret, `.env` name `VILAO_PAT` | unset | The billing provider's read-only access token. Optional: see "Without a billing provider". |

`vilao_pat` is declared `type: secret`, so it never lands in `config.yaml`. The hub's field shows only
whether a value is present; saving it writes the `VILAO_PAT` variable into that home's `.env` through the
app's credential route. The page's own settings route drops the key by name, so the value cannot reach
the renderer even if it were somehow in the subtree.

The page reads the three non-secret settings through one route. A key you never set answers with the
default above instead of being absent, so a fresh install paints English and dong rather than failing to
paint. Language and money unit are applied during render, not in an effect: a frame in the wrong language
is what a locale switch looks like when it is a bug.

## What it reads and sends

Every line here is a property of this tree, and the two commands under it re-check the part a reader
cannot see from a diff.

- **Two outbound hosts, GET only.** `https://vilao.ai/api/v2` (wallet balance, per-request usage ledger,
  the account's keys and their price books, top-up history) and
  `https://vilao.ai/api/v1/llm/marketplace/models` (the public price list — a keyless page, fetched on its
  own unauthenticated path, so the access token never goes to it), plus
  `https://open.er-api.com/v6/latest/USD` for the USD→VND rate (keyless, cached,
  refreshed on a 6-hour TTL at most). Nothing else on the network is contacted.
- **No write endpoint is named anywhere in the tree.** The only `.post(` is this plugin's own loopback
  route `POST /api/plugins/call-ledger/sync`, which triggers a read-only pull of the bill; the only
  `.delete(` is a JavaScript `Set`. A billing token is attached to GET requests and nothing else.
- **The host allowlist is enforced before the Authorization header is built.** The authenticated GET
  helper builds the URL, requires `https` and a host inside `{"vilao.ai", "www.vilao.ai"}`, and raises
  before it reads the secret — an off-allowlist URL is refused without ever receiving the token. The test
  `test_bill_get_will_not_carry_the_token_offsite` covers an unrelated host, plain http, and the
  suffix-confusion case `vilao.ai.evil.example`. The two other authenticated call sites build their URLs
  from the module constant, so no request parameter can steer the host, and a key id interpolated into a
  path is matched against a uuid-shaped pattern first.
- **One secret, read one way.** `VILAO_PAT` through Hermes' own secret scope
  (`agent.secret_scope.get_secret`), falling back to the home's `.env` line. Errors name the variable or
  the HTTP status, never the value, and no route returns it. Two optional variables pin the FX rate
  outright and skip the feed: `VILAO_USD_VND`, and `VILAO_CNY_VND` for yuan.
- **Everything it stores is in one directory named `plugin-data/call-ledger/`.** The SQLite ledger and the
  marketplace cache under the Hermes install root, the FX cache inside the active home — resolved through
  `get_default_hermes_root()` / `get_hermes_home()`, never a hardcoded path. Writes are a temp file plus an
  atomic replace, or SQLite. Nothing is written inside the plugin's own tree: no updater, no fetched
  `plugin.js`, no release downloader.
- **Registered surface.** Three observer hooks (`post_api_request`, `post_auxiliary_call`,
  `api_request_error`), one dashboard router (fifteen GET routes and that one POST), one Desktop route,
  one sidebar entry, one palette command, one keybinding. No core object is patched, no module table is
  written. The page touches the app's document only to hand a CSV export to the browser's download and to
  focus its own filter box; preferences go through the plugin storage door, not `localStorage`.
- **No declared Python dependencies.** No `pyproject.toml`, no `requirements.txt` — deliberate, and the
  same reason other catalog entries give it: it keeps the plugin out of the runtime's dependency
  workspace, so one clone serves several profiles. The imports are the standard library, `httpx` and
  `fastapi` (both already in the Hermes runtime), and two public Hermes modules used for path resolution
  and for the secret.
- **No subprocess, no telemetry, no network at import.** Nothing in the tree shells out; the only egress
  is the two hosts above; importing the plugin opens no socket, because every client call sits inside a
  function reached from a hook, a route or a sync. No other tool's credential file is read — not a
  keychain, not another plugin's cache, not a container env file.
- **Links out are checked too.** The marketplace rows can carry a console page per offer; the link is only
  built when both path segments are plain slugs, and only `https` URLs on `vilao.ai` are handed to the
  system browser.

Re-check the two claims a diff cannot show, over the shipped code (tests are left out on purpose — they
name refused hosts to prove the refusal):

```
grep -rnE "https?://" *.py dashboard/*.py desktop/*.js
grep -rnE "\.(post|put|patch|delete)\(|subprocess|os\.system|Popen|import socket|eval\(|new Function" \
  *.py dashboard/*.py desktop/*.js
```

The first prints `vilao.ai` and `open.er-api.com` URLs and the allowlist check itself, and nothing else.
The second returns this plugin's own `POST /sync` route and one `Set.delete` in the page code.

## Vilao, in one paragraph

**Vilao AI** (`vilao.ai`) is a Vietnamese model marketplace and OpenAI-compatible gateway: one API key
fronts many vendors' models, and the account is billed in VND against a prepaid wallet. This plugin reads
four things from it — the wallet balance and top-up history, the per-request usage ledger, the account's
keys with their price books, and the public marketplace price list — and never calls a write endpoint.
**It is optional.** With no `VILAO_PAT` configured the plugin still records every Hermes call from the
hooks and shows tokens, models, sessions, per-day trends and the internal USD estimate. Two honesty notes
belong in this paragraph rather than in a footnote. Vilao issues one **full-scope** personal access token
per account, and it carries `wallet:write`; that is exactly why this client refuses any verb but GET and
any host off the allowlist. And the marketplace rows are **offers**, not models — several providers sell
the same model at different prices — which is why that table is keyed by `(provider, model)` and labelled
as offers instead of pretending to be a model list.

Where a bill row and a log row describe the same call, the pairing is by model key and nearest timestamp
within 90 seconds, closest gap first, and only over rows recorded while the hooks were live. A charge that
finds no call of its own stays in the log on its own, labelled as bill-only, instead of being attributed
to whichever profile happened to run the sync; a call with no charge beside it is marked as an estimate.
Per-token prices are divided by the shape the bill actually charges (input + output + cache read), not the
shape Hermes reports.

## Without a billing provider

With no `VILAO_PAT`, the ledger is complete: the three hooks write every call, so **Live** (in Hermes
mode), **Trend**, **Log** and **Quota** all work from the local store — token splits, per-day totals, the
year grid, per-model and per-session rollups, the measured request rate, CSV export. Nothing about
recording depends on a vendor.

What stays empty is the part that only a billing provider can answer, and each tab says so in its own
line instead of rendering a blank card:

- **Wallet** and **Keys** call the provider's balance and key routes, which answer 401 naming `VILAO_PAT`;
  the tabs print their read-failure line ("Could not read the vilao wallet: …", "Could not read the key
  list."). The Wallet tab's stat cards have no figure to show, so they read 0 and its running-low card
  appears — that card is a consequence of having no balance to read, not a warning about your account.
- **Models** keeps working, because the price list is a public page: the plugin fetches it on its own
  unauthenticated path, so with no `VILAO_PAT` the offers and their list prices still arrive. What has
  nothing to show is the pair of columns computed from your own billing -- "you paid" and "dong/1M you
  paid" read 0 for an offer that matches a logged call and a dash for one that does not, because the
  store holds no bill rows.
- Every money figure that would have come from the invoice is absent. Per-row money cells fall back to
  Hermes' USD estimate — converted at the published rate when one is available, and tagged `est` so it is
  never mistaken for a charge — or print a dash where there is no estimate either. Billed totals read 0,
  because the store holds no bill rows.

Adding a token later changes nothing about the history already recorded: the next sync pairs new charges
against the calls already in the store.

## Coexistence with hermes-resetwatch

This plugin registers the same three hooks as `hermes-resetwatch` (Adolanium): both observe every model
call. Installing both writes two separate ledgers of the same calls, and each page reports a total the
other cannot see, so neither one on its own is the number to take to an invoice. **Pick one.** Remove the
other with `hermes plugins remove <name>` and restart the app.

One detail worth knowing before you decide, because it makes the two installs less independent than two
pages suggest: this plugin drains older per-profile ledger files it finds under the install root's
`profiles/` tree into the shared store. That read is incremental, read-only against the source file, and
additive — rows the store already holds are rejected by its unique indexes — but a still-running older
install keeps writing into a directory this drain knows, so some of its rows can surface here as well.

There is deliberately no coexistence warning. Deciding whether to nag you would mean reading another
plugin's settings or state, and that is the credential-adjacent behaviour this release is distancing
itself from, so the choice stays where it belongs: with the person installing.

## Known limits

- **The USD estimate is not a price.** It comes from Hermes' own price book, and for a provider id that
  book has no entry for there is nothing to estimate: the row keeps no estimate, its money cell prints a
  dash, and a day or model total that mixes such rows adds nothing for them, so the estimate column can
  read 0 while the call clearly cost something. Real dong comes from the billing feed, never from the
  estimate — which is the reason the two feeds are kept apart instead of averaged.
- **One billing provider: vilao.** The marketplace and wallet tabs are vilao because the bill adapter that
  exists is the one for vilao's usage API. Generalising it to any OpenAI-compatible usage endpoint is
  unwritten, not hidden; without that provider configured, see "Without a billing provider".
- **Vietnamese is a plugin-scoped locale.** The Desktop app itself cannot select `vi` — its bundled
  languages are `en, zh, zh-hant, ja, ar, ru, fr, de, es` — so "follow the app's language" alone can never
  produce Vietnamese, and this plugin ships its own `en` and `vi` bundles with a `language` setting. The
  setting changes this page, not the app: registering `vi` as an app-wide language from a cost ledger
  would put a mostly-English app under a Vietnamese label, which is a language pack's job, not this one's.
  The two bundles are kept key-for-key by a gate, so a string missing from Vietnamese fails a check
  instead of quietly answering English.
- **Retention is 400 days.** Rows older than that are pruned, and the marketplace price snapshots that
  power the "what moved since yesterday" column are kept for 120 days. A year of history is only as
  complete as the bill walk that reached it — a half-read bill looks exactly like an empty one — so the
  year grid prints the date the billing data actually reaches back to, which is how a blank month is
  told apart from an unread one.
- **One store per home.** The ledger is a single SQLite file under the Hermes install root, so a multiplex
  install that serves several profiles writes all of them into it — which is why every row carries the
  profile that made the call and the page can filter by home. Billing rows carry none on purpose: a charge
  belongs to the account and the key that was billed, not to a profile.
- **Money needs a rate to cross units, and says which rate it used.** Every conversion uses the rate
  `/fx` reports, and the page's footer names that rate's source: the public feed, a hand-set
  `VILAO_USD_VND`, or a cached quote the module marks as an old price when the feed could not be reached.
  With none of the three there is no rate: the rate line says so, and every figure that would need a
  conversion prints `—`. Nothing in the tree invents a rate to print in its place.
- **The Quota tab is measured, not reported.** It counts this store's own rows per provider; the free
  tiers most accounts lean on publish a request limit and no usage API, so no one else's number exists.

## Development

```
hermes plugins validate .                 # catalog admission checks: run before you push
py -3.13 -m pytest tests -q               # store, matcher, routes, settings, identity + the gates
py -3.13 tools/scan_secrets.py            # 0 hits: token shapes, and the live values, never printed
py -3.13 tools/scan_pii.py .              # 0 hits: no machine path, profile name or private tooling
node tests/render_plugin.mjs              # renders every tab under en and under vi
node tools/no_literal.mjs                 # no page copy outside the bundles, every key resolvable
node tests/ui_units.mjs                   # the pure table helpers and the money printer
node --test tests/locale.test.mjs tests/locale_parity.test.mjs   # resolver + bundle parity
```

`hermes plugins validate .` is the pre-push step and the one command CI here does not run: it needs a
provisioned Hermes environment, and a plugin repository must not install one on a runner. The catalog's own
CI runs it against the commit that gets pinned.

Two Node 22 caveats: one makes a gate pass while doing nothing, the other makes a correct page look broken.

- List the test files. `node --test tests` resolves a bare directory as a module and matches no test file,
  so it reports success while running nothing.
- Run `node tests/render_plugin.mjs` **first**. It writes `tests/page-under-test.mjs` — a copy of the page
  with its imports rewritten to local stubs — and `tests/ui_units.mjs` and the two `*.test.mjs` files
  import that copy. The literal gate refuses to run against a generated file older than the page, which is
  why order is load-bearing rather than cosmetic.

The JS gates borrow React from a Hermes checkout: `HERMES_AGENT_DIR=/path/to/hermes-agent` points them at
one, and unset they fall back to the Hermes install on the machine. `.github/workflows/validate.yml` runs
everything above except `hermes plugins validate`, with that variable set explicitly.

`tests/dump_fixtures.py` rebuilds `tests/fixtures.json` from a temporary home seeded with synthetic rows,
never from a live store, so the harness sees the shapes the routes really return without depending on
anybody's account. Every store-touching test points `HERMES_HOME` at a temporary directory; keep it that
way when you add one, because a `HERMES_HOME` inside a real install resolves back to that install's root
and the test then writes into the live ledger. `close_connections()` exists because an open SQLite handle
blocks temporary-directory deletion on Windows.

## Lineage

Derived from **`hermes-resetwatch`** (Adolanium), a Desktop plugin in the Hermes plugin catalog
(`https://github.com/Adolanium/hermes-resetwatch`). What is inherited is the slot: the plugin id shape, the
route-and-nav-and-palette shell, the three observer hooks and the manifest's frame. What is not inherited
is everything that made the two plugins answer different questions.

`hermes-resetwatch` is a quota reader. Its own catalog entry describes the method: a probe script reads
provider API keys from the Hermes `.env` and from other tools' local stores — a secret-cache file,
container env files, other coding CLIs' logins including macOS keychain entries — and sends each key to its
own vendor's usage endpoint to ask how much quota is left. That half does not exist in this tree at all:
there is no probe script, no other tool's credential is read, and the outbound surface is two named hosts
with one declared secret. What replaced it is a persisted ledger — 400 days of per-call rows, incremental
day rollups maintained inside the write transaction, a bill feed paired to it, a marketplace price watch,
seven tabs, and both string bundles. The questions differ too: not "how much quota is left" but "which
call, which model, which day, which session cost what, in the currency I was actually billed".

This release is MIT (see `LICENSE`); the upstream project's own terms are in its repository. The version
line restarts at 1.0.0 because the private 0.4.0 build it came from is not install-compatible with this
one — see `CHANGELOG.md`.
