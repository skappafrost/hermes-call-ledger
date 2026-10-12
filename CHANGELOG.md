# Changelog

Versions are semantic and this file describes released states of the plugin, newest first. The public
line starts at 1.0.0; the private build it was rebuilt from is described in "Not install-compatible"
below rather than pretended away.

## 1.0.0 — public release

First release as a public repository and a catalog-submittable plugin, under the MIT licence.

### Renamed

- Plugin id, Desktop route, sidebar label and store directory all moved to the new identity: id
  `hermes-call-ledger`, route `/call-ledger`, nav and page title **Call Ledger**, state in
  `plugin-data/call-ledger/`. The version line restarts at 1.0.0 with it, because the rename is not an
  in-place upgrade.
- The old palette command, keybinding id and dashboard mount prefix went with the id, so nothing this
  plugin registers is addressed by the name it had before.
- The catalog entry's `author` is the maintainer of this repository. Lineage credit — the plugin whose
  install slot this one took — lives in the README's Lineage section, not in a manifest identity field.

### Bilingual UI

- Complete English string bundle plus a first-class Vietnamese bundle, both registered through the
  Desktop plugin i18n door (`ctx.i18n.register`). English is the default and the documented fallback;
  Vietnamese is plugin-scoped, because the Desktop app itself has no `vi` to select, and the plugin does
  not register one app-wide.
- Three gates make the split verifiable rather than claimed: recursive key parity between the two
  bundles, zero page copy outside them, and the render harness drawing every tab once per locale and
  asserting that locale's markers.

### Settings surface

- `plugin.yaml` now declares a `config_schema`, so the settings appear as form fields in the Plugins hub
  instead of living only in documentation: `language` (`auto` | `en` | `vi`, default `auto`), `currency`
  (`auto` | `vnd` | `usd`, default `auto`), `lookback_days` (int, default `30`) and `vilao_pat`, declared
  `type: secret` with `env: VILAO_PAT`, which the app stores in the home's `.env` and never in
  `config.yaml`.
- One read-only route (`GET /settings`) answers the three non-secret keys for the page, merged onto the
  manifest's defaults, with secret keys filtered by name so a value cannot reach the renderer.
- Money formatting goes through one printer, keyed by the resolved locale (`1.234đ` under `vi-VN`,
  `$1,234.56` under `en-US`). The page no longer converts at a bootstrap number of its own: every crossing
  uses the rate the backend reports, names that rate's source in the footer, and prints `—` where a figure
  would need a conversion and there is no rate to make it.

### Not install-compatible

The private 0.4.0 line this was rebuilt from is **not** install-compatible, and that has a consequence a
user will feel. The store directory is derived from the plugin id, so installing 1.0.0 next to the older
build starts you a **fresh ledger** — the two plugins keep separate databases, separate routes and separate
nav entries, and the older store is not taken over in place. One documented exception carries history
across: on first open, the shared store drains rows that an older build wrote into the per-profile store
directories under the install root's `profiles/` tree. That read is incremental, read-only against the
source files, and covers only those per-profile stores — a ledger sitting directly in the default home is
not part of it, and no other state (caches, settings, keys) is reused.

If you are running the older build and want its history, export what you need from it before installing
this one: nothing in this release reads another plugin's store directory. The two can stay installed
together — the older build registers no observer hooks and keeps no call ledger, so there is no double
count to agree on; the README's Coexistence section says what each one does.

### Disclosure, restated for this release

Two outbound hosts and both GET-only (`vilao.ai`, `open.er-api.com`), the host allowlist enforced before
the Authorization header is built, one declared secret read through Hermes' secret scope, all state under
`plugin-data/call-ledger/`, no declared Python dependencies, no subprocess, no telemetry, no self-updater,
and none of the credential-reading behaviour the upstream plugin it replaced is known for. The README's
"What it reads and sends" states each of these with the command that re-checks it.
