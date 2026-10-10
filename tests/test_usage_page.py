"""Tests for the Usage page backend: store, matcher, bill mapping, plugin-host loading.

Runs under pytest, and standalone: ``python tests/test_usage_page.py``.

Model names are real offers in the public vilao catalogue (`cx/gpt-6-astra`, `dogi/glm-5.3`,
`alic/glm-5.1`): the matcher has to be tested against the strings the marketplace really returns, and a
catalogue name is public product data, not anyone's personal data. Every *figure* beside them is
synthetic -- tokens, dong, latency, byte counts -- in this file and in tests/fixtures/usage_item.json.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent

# The store resolves the shared database through hermes_constants, which the app injects on boot. A
# standalone run has to point at a checkout or every test that touches a store dies on ImportError
# rather than testing anything -- and the clone is not beside one, so the resolver decides where it is.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_env import bootstrap_sys_path          # noqa: E402
bootstrap_sys_path()

def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _close_everything():
    for module in list(sys.modules.values()):
        closer = getattr(module, "close_connections", None)
        if callable(closer):
            closer()


def fresh_store(tmp: str):
    """A store bound to its own fake profile home, re-imported so module caches do not leak."""
    _close_everything()
    os.environ["HERMES_HOME"] = tmp
    for cached in ("rw_store", "rw_bill"):
        sys.modules.pop(cached, None)
    return _load("rw_store", PLUGIN_ROOT / "usage_store.py"), _load("rw_bill", PLUGIN_ROOT / "usage_bill.py")


def _local(store, ts, model="vilao-ai/cx/gpt-6-astra", tok_in=1000, tok_out=100, **kw):
    payload = {"session_id": "s1", "platform": "cli", "provider": "vilao-ai", "model": model,
               "api_mode": "chat_completions", "finish_reason": "stop", "context_length": 200000,
               "usage": {"input_tokens": tok_in, "output_tokens": tok_out},
               "api_duration": kw.get("api_duration", 1.5),
               "started_at": ts - kw.get("api_duration", 1.5), "ended_at": ts,
               "first_chunk_at": ts - 0.5}
    return store.record_local(ts=ts, payload=payload, est_cost_usd=kw.get("est", 0.0042))


def _bill(bill_mod, store, ts, model="cx/gpt-6-astra", tokens=1100, cost=19.4, rid=None, key=None):
    rid = rid or ("b-%s" % ts)
    row = bill_mod.to_row({"id": rid, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
                           "actual_model": model, "total_tokens": tokens, "total_cost": cost,
                           "consumer_key_id": key or "00000000-0000-4000-8000-000000000000",
                           "input_tokens": int(tokens * 0.9), "output_tokens": int(tokens * 0.1),
                           "cache_read_input_tokens": 120, "reasoning_tokens": 5,
                           "latency_ms": 1500, "success": True, "provider_type": "openai"})
    return store.record_bill_rows([row]), row


def _usage_item():
    """The recorded `/llm/usage` element: the provider's field names, one synthetic call's figures."""
    return json.loads((Path(__file__).parent / "fixtures" / "usage_item.json").read_text(encoding="utf-8"))


def test_matched_bill_is_not_reingested(tmp_path):
    """Re-syncing a page that contains an already-paired charge must not add it back.

    Pairing folds the bill into the call row, so unless the call row keeps the bill's id the next walk
    of the same page sees an unknown id and re-inserts the charge -- every matched call then bills twice.
    """
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 500, tok_in=1000, tok_out=100)
    _added, row = _bill(bill, store, now - 480, tokens=1100, rid="m1", cost=19.4)
    assert store.match_rows(since=now - 86400) == 1
    assert store.record_bill_rows([row]) == 0, "the paired bill was accepted again"
    assert store.stats()["rows"] == 1, store.recent(limit=5)
    assert store.summary(2)["dong"] == 19.4, store.summary(2)


def test_paired_row_keeps_the_key_and_the_bill_id(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 30, tok_in=1000, tok_out=100)
    _bill(bill, store, now - 20, tokens=1100, rid="k1")
    assert store.match_rows(since=now - 3600) == 1
    row = store.recent(limit=5)[0]
    assert row["match_state"] == "matched"
    assert row["bill_request_id"] == "k1"
    assert row["bill_key_id"] == "00000000-0000-4000-8000-000000000000"


def test_per_key_filter_and_backfill(tmp_path):
    """Old rows stored before the key was tracked get the key backfilled, then filter like the rest."""
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _bill(bill, store, now - 100, rid="a", key="key-one")
    _bill(bill, store, now - 90, rid="b", key="key-two")
    assert store.recent(key_id="key-one", billed_only=True)
    conn = store._connect(store.store_path())
    conn.execute("UPDATE calls SET bill_key_id=NULL")  # emulate the pre-key schema state
    assert store.recent(key_id="key-one", billed_only=True) == []
    _bill(bill, store, now - 100, rid="a", key="key-one")  # same id, skipped as known
    one = store.recent(key_id="key-one", billed_only=True)
    assert [r["bill_request_id"] for r in one] == ["a"], one
    assert store.stats()["rows"] == 2


def test_outcome_and_cost_filters(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    cheap = bill.to_row({"id": "cheap", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                         "actual_model": "cx/gpt-6-astra", "total_cost": 2.0, "total_tokens": 10,
                         "success": False})
    store.record_bill_rows([cheap])
    _bill(bill, store, now - 1, rid="paid", cost=9000.0)
    assert [r["bill_request_id"] for r in store.recent(outcome="error")] == ["cheap"]
    assert {r["bill_request_id"] for r in store.recent(outcome="ok")} == {"paid"}
    assert [r["bill_request_id"] for r in store.recent(min_dong=1000)] == ["paid"]


def test_pairing_compares_the_totals_each_side_actually_bills(tmp_path):
    """Hermes' token total is in+out; vilao's is in+out+cache-read, so the raw figures never agree.

    Comparing the raw totals rejects nearly every cached call: a call whose input was cached arrives as
    input+output from Hermes and as input+output+cache read on the bill. The comparison has to be made
    in each side's own billing units.
    """
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    payload = {"session_id": "s1", "platform": "cli", "provider": "vilao-ai",
               "model": "vilao-ai/cx/gpt-6-astra", "api_mode": "chat_completions",
               "finish_reason": "stop", "usage": {"input_tokens": 5000, "output_tokens": 250,
                                                   "cache_read_input_tokens": 100000},
               "api_duration": 2.4, "started_at": now - 2.4, "ended_at": now}
    store.record_local(ts=now, payload=payload, est_cost_usd=0.00074)
    row = store.recent(limit=1)[0]
    assert row["tok_total"] == 5250, row             # what Hermes reports as the call's own tokens
    _bill(bill, store, now + 0.2, tokens=105250, rid="cached-call", cost=19.4)
    assert store.match_rows(since=now - 3600) == 1, "a cached call and its charge did not pair"
    paired = store.recent(limit=2)[0]
    assert paired["bill_cost_vnd"] == 19.4 and paired["match_state"] == "matched", paired
    # a genuinely different call still must not be folded in: same model, wrong token mass
    _local(store, now - 600, tok_in=900, tok_out=90)
    _bill(bill, store, now - 600, tokens=500000, rid="other")
    assert store.match_rows(since=now - 7200) == 0, "unrelated rows paired"


def test_rate_window_and_provider_rollups(tmp_path):
    """The self-measured meters are the only quota signal the free tiers give, so they must add up."""
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    minute = int(now // 60) * 60 - 60          # a whole minute, one ago, so all seven share a bucket
    for i in range(7):
        _local(store, minute + i * 4)
    _local(store, now - 7200, model="vilao-ai/alic/glm-5.1")  # two hours ago, different model
    _bill(bill, store, minute + 30, cost=250.0)
    window = store.rate_window(24)
    assert window["calls"] == 9, window
    assert window["peak_rpm"] == 8, window      # 7 calls + 1 charge in that same minute
    assert window["peak_rph"] >= 9, window
    assert round(window["dong"], 2) == 250.0, window
    per = {r["provider"]: r for r in store.rate_by_provider(24)}
    assert set(per) >= {"vilao-ai"}, per
    assert per["vilao-ai"]["calls"] >= 1 and per["vilao-ai"]["peak_rpm"] >= 1, per
    assert per["vilao-ai"]["errors"] == 0, per


def test_usage_by_model_spans_the_whole_store(tmp_path):
    """A model last used two months ago must still show its history in the catalogue join."""
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _bill(bill, store, now - 90 * 86400, model="cx/gpt-6-astra", rid="old", cost=4000.0, tokens=12000)
    _bill(bill, store, now - 3600, model="alic/glm-5.1", rid="new", cost=10.0, tokens=500)
    rows = store.usage_by_model()
    assert [r["model_key"] for r in rows] == ["cx/gpt-6-astra", "alic/glm-5.1"], rows
    assert rows[0]["dong"] == 4000.0 and rows[0]["days"] == 1, rows[0]
    narrowed = store.usage_by_model(["vilao-ai/alic/glm-5.1"])
    assert [r["model_key"] for r in narrowed] == ["alic/glm-5.1"], narrowed


def test_profiles_seen_names_what_is_contributing(tmp_path):
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 10)
    _local(store, now - 5, model="vilao-ai/alic/glm-5.1")
    rows = store.profiles_seen()
    # a home that is not under profiles/ is the default one, not a directory name
    assert len(rows) == 1 and rows[0]["profile"] == "default", rows
    assert rows[0]["calls"] == 2 and rows[0]["local_rows"] == 2, rows


def test_dong_since_window(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _bill(bill, store, now - 3600, rid="in", cost=500.0)
    _bill(bill, store, now - 90000, rid="out", cost=800.0)
    assert store.dong_since(86400) == 500.0
    assert store.dong_by_key_since(86400) == {"00000000-0000-4000-8000-000000000000": 500.0}


def test_a_stalled_page_is_retried_before_the_walk_gives_up(tmp_path):
    """One slow deep page must not abort a walk that has already spent minutes fetching."""
    import httpx

    os.environ.setdefault("HERMES_HOME", os.getcwd())
    sys.modules.pop("rw_bill_retry", None)
    bill = _load("rw_bill_retry", PLUGIN_ROOT / "usage_bill.py")

    class Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [{"id": "p-1"}]}

    class OnceFlaky:
        def __init__(self):
            self.calls = 0

        def get(self, url, params=None):
            self.calls += 1
            if self.calls == 1:
                raise httpx.ReadTimeout("stalled")
            return Resp()

    client = OnceFlaky()
    assert bill._page(client, 91, 365) == [{"id": "p-1"}]
    assert client.calls == 2, client.calls

    class AlwaysDown:
        def __init__(self):
            self.calls = 0

        def get(self, url, params=None):
            self.calls += 1
            raise httpx.ConnectError("no route")

    down = AlwaysDown()
    try:
        bill._page(down, 91, 365)
    except httpx.ConnectError:
        pass
    else:
        raise AssertionError("a page that never answers must raise")
    assert down.calls == 2, down.calls


def test_ingest_fresh_stop_halts_at_the_frontier(tmp_path):
    """A five-minute poll must cost the new pages only, not a re-walk of the whole horizon."""
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _bill(bill, store, now - 10, rid="known", cost=7.0)
    known, _row = _bill(bill, store, now - 5, rid="also-known", cost=3.0)
    assert known == 1
    pages = [
        (1, [bill.to_row({"id": "new-1", "created_at": _iso(now - 2), "total_cost": 1.0,
                          "total_tokens": 5, "actual_model": "cx/gpt-6-astra"})]),
        (2, [_row]),
        (3, [bill.to_row({"id": "never-seen", "created_at": _iso(now - 1), "total_cost": 1.0,
                          "total_tokens": 5, "actual_model": "cx/gpt-6-astra"})]),
    ]
    seen = []

    def fake_iter_pages(days, start_page=1, budget=8):
        for page, rows in pages:
            if page >= start_page and page < start_page + budget:
                seen.append(page)
                yield page, rows

    bill.iter_pages = fake_iter_pages
    result = bill.ingest(store, days=30, budget=8, fresh_stop=True)
    assert seen == [1, 2], seen
    assert result["done"] is True and result["next_page"] == 1, result
    assert result["stored"] == 1, result


def test_a_replayed_charge_is_dropped_not_double_counted(tmp_path):
    """Rows paired by the older build never got the bill id, so its charge replays on the next walk.

    That replay cannot be recognised by id; it is recognised by being the same model, the same cost and
    the same instant as a call that is already billed. A zero-cost duplicate is kept -- it cannot
    distort a sum, and two genuinely free calls in one minute are plausible.
    """
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 40, tok_in=1000, tok_out=100)
    _added, row = _bill(bill, store, now - 30, tokens=1100, rid="re", cost=19.4)
    assert store.match_rows(since=now - 3600) == 1
    conn = store._connect(store.store_path())
    conn.execute("UPDATE calls SET bill_request_id=NULL, bill_key_id=NULL WHERE match_state='matched'")
    assert store.record_bill_rows([row]) == 1, "the replay was still recognised by id"
    assert store.match_rows(since=now - 3600) == 0
    assert store.stats()["rows"] == 1, store.recent(limit=5)
    assert store.summary(2)["dong"] == 19.4, store.summary(2)
    # the replay was the only surviving copy of that call's API key, so it is handed over before the row goes
    assert store.recent(limit=5)[0]["bill_key_id"] == row["bill_key_id"], store.recent(limit=5)
    free = bill.to_row({"id": "free", "created_at": _iso(now - 20), "actual_model": "cx/gpt-6-astra",
                        "total_cost": 0.0, "total_tokens": 1100})
    assert store.record_bill_rows([free]) == 1
    assert store.match_rows(since=now - 3600) == 0
    assert store.stats()["rows"] == 2, store.recent(limit=5)


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def test_double_hook_fire_counts_once(tmp_path):
    """The plugin is mounted in the launch scope and (via junction) the profile scope, so one call
    can reach the observer hook twice in the same multiplex process. That must not double-count."""
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    first = _local(store, now)
    again = _local(store, now)
    assert first is not None and again is None, (first, again)
    assert store.stats()["rows"] == 1, store.recent(limit=5)


def test_bill_rows_are_not_deduped_by_the_local_guard(tmp_path):
    """Two bills in the same instant with a NULL session_id must both survive the partial index."""
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _bill(bill, store, now, tokens=1100, rid="twin-a")
    _bill(bill, store, now, tokens=1100, rid="twin-b")
    assert store.stats()["rows"] == 2, store.recent(limit=5)


def test_store_roundtrip_and_aggregates(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 3600)
    _local(store, now - 60, tok_in=2000, tok_out=200)
    rows = store.recent(limit=10)
    assert len(rows) == 2, rows
    assert rows[0]["tok_total"] == 2200
    assert rows[0]["est_cost_usd"] == 0.0042 and rows[0]["model_key"] == "cx/gpt-6-astra"
    assert rows[0]["match_state"] == "local_only" and rows[0]["source"] == "hook"
    daily = store.daily(2)
    assert sum(int(d["calls"]) for d in daily) == 2
    summary = store.summary(2)
    assert summary["calls"] == 2 and abs(summary["usd_estimated"] - 0.0084) < 1e-9
    assert summary["counts"].get("local_only") == 2
    # a day x model matrix is the whole point of this store
    matrix = store.matrix(2)
    assert matrix and matrix[0]["model_key"] == "cx/gpt-6-astra"
    assert store.stats()["rows"] == 2


def _write_legacy(path, rows):
    """One file in the shape the pre-shared build wrote: no bill_key_id column at all."""
    import sqlite3

    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, profile TEXT, session_id TEXT,
        platform TEXT, task TEXT, provider TEXT, model TEXT, model_key TEXT, api_mode TEXT,
        tok_in INTEGER DEFAULT 0, tok_out INTEGER DEFAULT 0, tok_cache_read INTEGER DEFAULT 0,
        tok_cache_write INTEGER DEFAULT 0, tok_reasoning INTEGER DEFAULT 0, tok_total INTEGER DEFAULT 0,
        duration_ms INTEGER, ttft_ms INTEGER, finish_reason TEXT, context_length INTEGER,
        est_cost_usd REAL, bill_cost_vnd REAL, match_state TEXT NOT NULL DEFAULT 'local_only',
        bill_request_id TEXT, source TEXT NOT NULL DEFAULT 'hook')""")
    conn.executemany("""INSERT INTO calls (ts, profile, session_id, provider, model, tok_total,
        bill_cost_vnd, bill_request_id, match_state, est_cost_usd, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", rows)
    conn.commit()
    conn.close()


def _write_legacy_rows(path, rows):
    import sqlite3

    conn = sqlite3.connect(path)
    conn.executemany("""INSERT INTO calls (ts, profile, session_id, provider, model, tok_total,
        bill_cost_vnd, bill_request_id, match_state, est_cost_usd, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", rows)
    conn.commit()
    conn.close()


def test_legacy_per_profile_stores_are_imported_once(tmp_path):
    """The charges already collected under one profile must not be stranded by the move.

    The import is additive and idempotent: the shared file keeps its own rows, a charge that arrives in
    two legacy stores is counted once, and it never runs twice. The legacy files are left in place -- this
    is a copy, not a move, so nothing can lose history if the run is interrupted.
    """
    home_a, home_b = tmp_path / "profiles" / "alpha", tmp_path / "profiles" / "beta"
    for h in (home_a, home_b):
        (h / "plugin-data" / "resetwatch").mkdir(parents=True)
    _close_everything()
    now = time.time()
    # Written by hand, not through the module: the module now resolves the shared path, and these files
    # have to look like what the previous build left behind -- including the older column set.
    _write_legacy(home_a / "plugin-data" / "resetwatch" / "calls.sqlite", [
        (now - 60, "alpha", "s1", "vilao-ai", "vilao-ai/cx/gpt-6-astra", 1100, None, None,
         "local_only", None, "hook"),
        (now - 30, "alpha", None, "vilao-ai", "cx/gpt-6-astra", 1100, 500.0, "legacy-1",
         "bill_only", None, "bill")])
    _write_legacy(home_b / "plugin-data" / "resetwatch" / "calls.sqlite", [
        (now - 20, "beta", "s2", "vilao-ai", "vilao-ai/alic/glm-5.1", 550, None, None,
         "local_only", None, "hook"),
        (now - 30, "beta", None, "vilao-ai", "cx/gpt-6-astra", 1100, 500.0, "legacy-1",
         "bill_only", None, "bill")])

    os.environ["HERMES_HOME"] = str(home_a)
    for stale in ("rw_store", "rw_bill"):
        sys.modules.pop(stale, None)
    store, bill = _load("rw_store", PLUGIN_ROOT / "usage_store.py"), _load("rw_bill", PLUGIN_ROOT / "usage_bill.py")
    rows = store.recent(limit=50)
    assert len(rows) == 3, rows                       # 2 hook rows + 1 charge, not 4
    # A hook row keeps the home that made the call; an imported charge does not, because the home that
    # happened to run the ingest never claimed to have made it.
    assert {r["profile"] for r in rows if r["source"] == "hook"} == {"alpha", "beta"}, rows
    assert [r["profile"] for r in rows if r["source"] == "bill"] == [""], rows
    assert store.summary(2)["dong"] == 500.0, store.summary(2)
    assert store.get_meta("legacy:alpha"), "the import was not recorded"
    store.close_connections()
    _close_everything()
    os.environ["HERMES_HOME"] = str(home_b)
    store2 = _load("rw_store_again", PLUGIN_ROOT / "usage_store.py")
    assert store2.stats()["rows"] == 3, store2.recent(limit=20)
    assert (home_a / "plugin-data" / "resetwatch" / "calls.sqlite").exists(), "a legacy file was removed"
    # and it stays incremental: a call written to the old path after the first import must still arrive,
    # or everything between the import and the app restarting would be stranded in a file nobody reads
    _write_legacy_rows(home_a / "plugin-data" / "resetwatch" / "calls.sqlite", [
        (time.time() + 5, "alpha", "s9", "opencode-zen", "opencode-zen/space-bunny-free", 900, None, None,
         "local_only", None, "hook")])
    store.close_connections()
    _close_everything()
    os.environ["HERMES_HOME"] = str(home_a)
    again = _load("rw_store_third", PLUGIN_ROOT / "usage_store.py")
    rows2 = again.recent(limit=50)
    assert len(rows2) == 4, rows2
    assert any(r["session_id"] == "s9" for r in rows2), rows2


def test_every_profile_lands_in_one_shared_store_tagged_by_profile(tmp_path):
    """Five homes, one database.

    The store used to sit inside whichever home made the call, so a page opened under one profile could
    not see the others and each home re-ingested the same vilao charges. Rows now go to one file under
    the install root and carry the acting profile in ``profile``; the row's own provenance is the column,
    not the path.
    """
    home_a, home_b = tmp_path / "profiles" / "alpha", tmp_path / "profiles" / "beta"
    home_a.mkdir(parents=True)
    home_b.mkdir(parents=True)
    _close_everything()
    for stale in ("rw_store", "rw_bill"):
        sys.modules.pop(stale, None)
    store, bill = _load("rw_store", PLUGIN_ROOT / "usage_store.py"), _load("rw_bill", PLUGIN_ROOT / "usage_bill.py")
    os.environ["HERMES_HOME"] = str(home_a)
    now = time.time()
    _local(store, now - 10, model="vilao-ai/alic/glm-5.1")
    os.environ["HERMES_HOME"] = str(home_b)
    _local(store, now - 5)
    shared = tmp_path / "plugin-data" / "call-ledger" / "calls.sqlite"
    assert shared.exists(), "the store did not land under the install root"
    assert not (home_a / "plugin-data").exists(), "a per-profile store was still written"
    rows = store.recent(limit=10)
    assert sorted(r["profile"] for r in rows) == ["alpha", "beta"], rows
    assert len(rows) == 2, rows


def test_bill_rows_are_ingested_once_no_matter_which_profile_asks(tmp_path):
    """Charges belong to the account, not to a profile: two homes syncing must not double-bill."""
    home_a, home_b = tmp_path / "profiles" / "one", tmp_path / "profiles" / "two"
    home_a.mkdir(parents=True)
    home_b.mkdir(parents=True)
    _close_everything()
    for stale in ("rw_store", "rw_bill"):
        sys.modules.pop(stale, None)
    store, bill = _load("rw_store", PLUGIN_ROOT / "usage_store.py"), _load("rw_bill", PLUGIN_ROOT / "usage_bill.py")
    now = time.time()
    os.environ["HERMES_HOME"] = str(home_a)
    added_a, row = _bill(bill, store, now - 30, rid="shared-1", cost=1234.5)
    os.environ["HERMES_HOME"] = str(home_b)
    added_b, _ = _bill(bill, store, now - 30, rid="shared-1", cost=1234.5)
    assert (added_a, added_b) == (1, 0), (added_a, added_b)
    assert store.summary(2)["dong"] == 1234.5, store.summary(2)


def test_retention_prunes_old_rows(tmp_path):
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - (store.RETENTION_DAYS + 5) * 86400)
    _local(store, now)
    assert store.stats()["rows"] == 2          # pruned at next open, not on write
    fresh_store(str(tmp_path))
    assert store.stats()["rows"] == 1


def test_bill_ingest_is_idempotent(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    added, row = _bill(bill, store, now - 100, rid="same")
    assert added == 1 and row["bill_cost_vnd"] == 19.4
    assert store.record_bill_rows([row]) == 0   # same bill_request_id is skipped
    assert store.stats()["rows"] == 1


def test_matching_rules(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    # 1: matched -- same model, 20 s apart, tokens within tolerance
    _local(store, now - 500, tok_in=1000, tok_out=100)
    _bill(bill, store, now - 480, tokens=1100, rid="m1")
    # 2: rejected -- tokens disagree beyond 0.5 %
    _local(store, now - 300, tok_in=1000, tok_out=100)
    _bill(bill, store, now - 290, tokens=1400, rid="m2")
    # 3: rejected -- different model
    _local(store, now - 200, model="vilao-ai/alic/glm-5.1", tok_in=500, tok_out=50)
    _bill(bill, store, now - 195, model="hpx/grok-4.5", tokens=550, rid="m3")
    # 4: rejected -- outside the 90 s window
    _local(store, now - 100, tok_in=800, tok_out=80)
    _bill(bill, store, now - 1, tokens=880, rid="m4")
    claimed = store.match_rows(since=now - 86400)
    assert claimed == 1, claimed
    rows = store.recent(limit=50)
    matched = [r for r in rows if r["match_state"] == "matched"]
    assert len(matched) == 1, matched
    # the bill row is folded into the call row and removed, so both figures live on one row
    assert matched[0]["bill_cost_vnd"] == 19.4 and matched[0]["est_cost_usd"] == 0.0042
    assert matched[0]["tok_total"] == 1100
    still_bills = sorted(r["bill_request_id"] for r in rows if r["match_state"] == "bill_only")
    assert still_bills == ["m2", "m3", "m4"], still_bills
    counts = store.summary(2)["counts"]
    # 4 local calls + 4 bills - the 1 bill folded into its call = 7 rows: 3 unpaired each + 1 matched
    assert counts == {"local_only": 3, "bill_only": 3, "matched": 1}, counts


def test_nearest_claim_wins_on_ties(tmp_path):
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 10, tok_in=1000, tok_out=100)
    _local(store, now - 4, tok_in=1000, tok_out=100)
    _bill(bill, store, now - 5, tokens=1100, rid="only")
    assert store.match_rows(since=now - 3600) == 1
    live = [r for r in store.recent(limit=10) if r["match_state"] == "matched"]
    assert len(live) == 1 and abs(live[0]["ts"] - (now - 4)) < 0.001


def test_model_key_normalisation(tmp_path):
    store, _bill = fresh_store(str(tmp_path))
    assert store.model_key("vilao-ai/cx/gpt-6-astra") == "cx/gpt-6-astra"
    assert store.model_key("VILAO-AI/Momi/Xiaomi/Mimo-V2.5-Pro") == "momi/xiaomi/mimo-v2.5-pro"
    # bill rows arrive prefix-free and must survive untouched, or nothing pairs
    assert store.model_key("cx/gpt-6-astra") == "cx/gpt-6-astra"
    assert store.model_key("alic/glm-5.1") == "alic/glm-5.1"
    assert store.model_key("anthropic/claude-sonnet-4-6") == "anthropic/claude-sonnet-4-6"
    assert store.model_key(None) == "?"


def test_rows_are_tagged_with_the_profile_that_made_them(tmp_path):
    """One module instance, two profile homes, one shared store.

    The multiplex gateway serves several profiles from one process while ``os.environ`` keeps the launch
    profile's home, so the row's profile must be resolved per write from the bound scope -- a store that
    read the env would label every profile's calls as whoever booted. The file itself is shared so one
    page can show every profile; the column, not the path, carries provenance.
    """
    home_a, home_b = tmp_path / "profiles" / "profA", tmp_path / "profiles" / "profB"
    home_a.mkdir(parents=True)
    home_b.mkdir(parents=True)
    _close_everything()
    os.environ["HERMES_HOME"] = str(home_a)
    store = _load("rw_store_scope", PLUGIN_ROOT / "usage_store.py")
    now = time.time()
    _local(store, now - 10)
    os.environ["HERMES_HOME"] = str(home_b)
    _local(store, now - 5, model="vilao-ai/alic/glm-5.1")
    assert store.stats()["rows"] == 2, store.recent(limit=5)
    assert {r["profile"] for r in store.recent(limit=5)} == {"profA", "profB"}, store.recent(limit=5)
    both = store.recent(limit=5)
    assert sorted(r["model_key"] for r in both) == ["alic/glm-5.1", "cx/gpt-6-astra"], both
    # and a profile filter narrows to that home only
    assert [r["profile"] for r in store.recent(limit=5, profile="profA")] == ["profA"]
    assert store.dong_since(86400) is not None


def test_hook_derives_duration_and_ttft():
    """The hook, not the store, turns the payload's seconds into ms -- and first-chunk beats last-chunk."""
    init = _load("rw_init", PLUGIN_ROOT / "__init__.py")
    ended = 1_700_000_100.0
    timing = init._timing({"api_duration": 1.234, "started_at": ended - 1.234, "ended_at": ended,
                           "first_chunk_at": ended - 0.734})
    assert timing == {"duration_ms": 1234, "ttft_ms": 500}, timing
    no_stream = init._timing({"api_duration": 0.42, "started_at": 100.0, "ended_at": 100.42})
    assert no_stream["duration_ms"] == 420 and no_stream["ttft_ms"] == 420
    assert init._timing({}) == {"duration_ms": None, "ttft_ms": None}


def test_bill_row_maps_a_vilao_usage_element():
    """The fixture is a `/llm/usage` element in shape; its figures are invented, not measured."""
    os.environ.setdefault("HERMES_HOME", os.getcwd())
    bill = _load("rw_bill", PLUGIN_ROOT / "usage_bill.py")
    row = bill.to_row(_usage_item())
    assert row["model"] == "example/model-x"
    assert row["bill_cost_vnd"] == 8.5
    assert row["tok_total"] == 25250 and row["usage"]["cache_read_tokens"] == 20000
    assert row["duration_ms"] == 2400 and row["ttft_ms"] == 700
    assert row["finish_reason"] == "stop"
    assert row["bill_request_id"] == "00000000-0000-4000-8000-000000000001"
    assert row["bill_key_id"] == "00000000-0000-4000-8000-000000000000"


def test_the_bill_fixture_keeps_the_billed_shape_while_staying_synthetic():
    """What the fixture exists to demonstrate: a bill prices input + output + cache read.

    The numbers are made up -- one real call's figures would be one person's account sitting in a public
    repository -- but the shape is the provider's, and `match_rows()` divides a đ/1M price by exactly that
    sum, so the invariant is what every future refresh of the file has to preserve.
    """
    item = _usage_item()
    billed = item["input_tokens"] + item["output_tokens"] + item["cache_read_input_tokens"]
    assert billed == item["total_tokens"], (billed, item["total_tokens"])
    assert item["input_cost"] + item["cache_read_cost"] + item["output_cost"] == item["total_cost"]
    assert item["reasoning_tokens"] < item["output_tokens"]
    # No client library and version of anyone's machine, and no real measurement date.
    assert item["user_agent"] == "example-client/1.0", item["user_agent"]
    assert item["created_at"].endswith("T00:00:00.000Z"), item["created_at"]


def test_deep_walk_resumes_and_a_pulse_does_not_rewind_it(tmp_path):
    """A twelve-month grid needs hundreds of pages, so the cursor has to move forward, not reset.

    ``full`` used to restart page 1 on every request of the run: the walk re-read the newest pages
    forever and the older charges stayed invisible. The refresh pulse reads the newest page by design
    and must not be the thing that rewinds a paused deep walk either.
    """
    os.environ["HERMES_HOME"] = str(tmp_path)
    sys.modules.pop("rw_api_walk", None)
    api = _load("rw_api_walk", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    seen = []

    def fake_ingest(store, **kw):
        seen.append(kw)
        return {"read": 5, "stored": 5, "matched": 0, "done": False,
                "next_page": int(kw["start_page"]) + 2, "pages": 2}

    api.bill.ingest = fake_ingest
    api.post_sync(days="365", restart=True)
    api.post_sync(days="365")
    api.post_sync(days="365")
    assert [k["start_page"] for k in seen] == [1, 3, 5], seen
    assert api.store.get_meta("bill_page") == "7"
    api.post_sync(days="30", pages=2, pulse=True)
    assert seen[-1]["start_page"] == 1 and seen[-1]["fresh_stop"] is True, seen[-1]
    assert api.store.get_meta("bill_page") == "7", "the pulse rewound the deep walk"


def test_fx_cache_ttl_then_stale_fallback(tmp_path):
    """The rate is fetched on a TTL, and when the fetch dies the last good value keeps printing.

    A dollar estimate converted at yesterday's rate is still readable; one that silently reverts to
    dollars on a page whose every other figure is dong is not.
    """
    os.environ["HERMES_HOME"] = str(tmp_path)
    sys.modules.pop("rw_fx", None)
    fx = _load("rw_fx", PLUGIN_ROOT / "fx.py")
    calls = []

    def fake_fetch():
        calls.append(1)
        return {"usd_vnd": 25000.0, "cny_vnd": 3500.0, "at": time.time(), "source": "test"}

    fx._fetch = fake_fetch
    assert fx.rates()["usd_vnd"] == 25000.0 and len(calls) == 1
    assert fx.rates()["usd_vnd"] == 25000.0 and len(calls) == 1, "the TTL was ignored"
    assert fx.cache_path().exists(), "the rate was never cached"

    stored = json.loads(fx.cache_path().read_text(encoding="utf-8"))
    stored["at"] = time.time() - fx.TTL_S - 1
    fx.cache_path().write_text(json.dumps(stored), encoding="utf-8")

    def broken_fetch():
        raise RuntimeError("offline")

    fx._fetch = broken_fetch
    stale = fx.rates()
    assert stale["stale"] is True and stale["usd_vnd"] == 25000.0
    assert fx.to_vnd(2, "USD", stale) == 50000.0
    assert fx.to_vnd(1234.0, "VND", stale) == 1234.0, "dong must not be converted twice"
    assert fx.to_vnd(2, "RUB", stale) is None, "an unknown currency must not be guessed"
    assert fx.to_vnd(None, "USD", stale) is None


def test_fx_reports_no_rate_when_there_is_no_feed_and_no_cache(tmp_path, monkeypatch):
    """No cached rate and an unreachable feed is "no rate" -- never a number the module invented.

    The rule this release is built on is that a crossing between units needs a rate the machine actually
    has: with none, the estimate column prints an em dash and the footer says the rate is unknown. The
    old fallback answered with a pinned dong figure beside ``source: "hardcoded"``, which is a fabricated
    price wearing a quoted one's formatting, and every layer above the backend -- the printer, the page,
    the README, the CHANGELOG -- was written for the rule. The backend was the one place still breaking
    it, so the invented number goes and the cached/stale paths stay exactly as they were.
    """
    home = str(tmp_path / "fresh")
    monkeypatch.setenv("HERMES_HOME", home)
    for pin in ("VILAO_USD_VND", "VILAO_CNY_VND"):
        monkeypatch.delenv(pin, raising=False)
    sys.modules.pop("rw_fx_norate", None)
    fx = _load("rw_fx_norate", PLUGIN_ROOT / "fx.py")

    def broken_fetch():
        raise RuntimeError("offline")

    monkeypatch.setattr(fx, "_fetch", broken_fetch)
    assert fx.cache_path() is not None and not fx.cache_path().exists(), "the premise is a cold cache"
    assert fx.rates() is None, "a rate was reported that nothing quoted"
    assert fx.to_vnd(2.0, "USD") is None, "an estimate was converted with no rate to convert at"
    assert not hasattr(fx, "BOOTSTRAP_USD_VND"), "the invented dong figure is still in the module"
    assert not hasattr(fx, "BOOTSTRAP_CNY_VND"), "the invented yuan figure is still in the module"

    # The route is what the page reads: it answers "no rate", and the rate line prints the unknown.
    api = _load("rw_fx_norate_route", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    monkeypatch.setattr(api.fx, "_fetch", broken_fetch)
    assert api.get_fx() == {"fx": None}, api.get_fx()

    # A dong amount never needed a rate, and still does not: that is the display's own unit.
    assert fx.to_vnd(1234.0, "VND") == 1234.0


def test_the_two_path_rules_are_the_ones_the_docstrings_state(tmp_path, monkeypatch):
    """One shared ledger, one per-home rate cache -- and the prose has to say which is which.

    The ledger and the catalogue are one account's truth, so both resolve through
    ``get_default_hermes_root()``: the home that kept its own copy of the ledger was blind to every other
    profile and re-ingested the same vilao charges once per home. The FX cache is the acting home's own
    file, through ``get_hermes_home()``, because a spot rate is a display conversion rather than account
    history and the same quote means the same thing in every home.

    Both halves used to be stated wrongly in the shipped module docstrings -- "one file per profile" for a
    store that is one file for every profile, ``plugin-data/fx/`` for a cache that lives under
    ``plugin-data/call-ledger/`` -- and the rule is not decoration: a contributor who believes either one
    looks for a file that is not there, and a disclosure line written from the comment instead of the code
    puts a false statement about where user data lives into the catalog. So the resolution is proven from
    the functions first, then the two sentences are checked against it. Comments and a test only: the
    resolvers themselves are untouched.
    """
    root = Path(tmp_path)
    acting = root / "profiles" / "alpha"
    monkeypatch.setenv("HERMES_HOME", str(acting))
    for name in ("rw_rule_store", "rw_rule_rd", "rw_rule_fx"):
        sys.modules.pop(name, None)
    store = _load("rw_rule_store", PLUGIN_ROOT / "usage_store.py")
    rd = _load("rw_rule_rd", PLUGIN_ROOT / "vilao_read.py")
    fx = _load("rw_rule_fx", PLUGIN_ROOT / "fx.py")

    shared = root / "plugin-data" / "call-ledger"
    assert os.path.dirname(store.store_path()) == str(shared), store.store_path()
    assert rd.cache_dir() == shared, rd.cache_dir()
    assert fx.cache_path() == acting / "plugin-data" / "call-ledger" / "usd-vnd.json", fx.cache_path()

    doc = (PLUGIN_ROOT / "usage_store.py").read_text(encoding="utf-8").split('"""')[1]
    assert "One file per profile" not in doc, "the store docstring still claims a file per home"
    assert "get_default_hermes_root" in doc and "calls.sqlite" in doc, doc[:160]
    fxdoc = (PLUGIN_ROOT / "fx.py").read_text(encoding="utf-8").split('"""')[1]
    assert "plugin-data/fx" not in fxdoc, "the cache dir named here is not the one cache_path() builds"
    assert "get_hermes_home" in fxdoc and "usd-vnd.json" in fxdoc, fxdoc[:160]


def test_plugin_api_loads_without_a_parent_package(tmp_path):
    """The dashboard mounts plugin_api.py by path inside the plugin host: no package, no relative import.

    This is the shape that silently works in the agent process and fails only in the host, so it is
    asserted here rather than trusted.
    """
    os.environ["HERMES_HOME"] = str(tmp_path)
    api = _load("rw_api_isolated", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    now = time.time()
    _local(api.store, now - 5)
    _bill(api.bill, api.store, now - 4, tokens=1100, rid="host")
    assert api.store.stats()["rows"] == 2
    calls = api.get_calls(per=10)["calls"]
    assert len(calls) == 2
    assert api.get_summary("7")["summary"]["calls"] == 2
    assert api.get_matrix("7")["rows"]
    # paging: the whole store has to be reachable, so the answer says how many pages there are
    page1 = api.get_calls(per=1, page=1)
    assert page1["total"] == 2 and page1["pages"] == 2, page1
    assert len(page1["calls"]) == 1
    page2 = api.get_calls(per=1, page=2)
    assert page2["calls"][0]["ts"] <= page1["calls"][0]["ts"]
    assert page2["calls"][0]["id"] != page1["calls"][0]["id"]
    assert api.get_calls(per=1, page=99)["calls"] == []
    # the Log tab's source split: hook rows are what Hermes itself called
    assert api.get_log("7")["models"]
    assert [m["model_key"] for m in api.get_log("7", source="hook")["models"]]
    assert api.get_summary("7", source="bill")["summary"]["calls"] >= 1
    health = api.get_health()
    assert health["ok"] is True and "pat_configured" in health
    # the rate the dollar estimates are printed in dong at -- loaded by path, like every sibling here
    assert api.fx is not None, "fx.py did not load inside the plugin host"
    api.fx._fetch = lambda: {"usd_vnd": 25000.0, "cny_vnd": 3500.0, "at": time.time(), "source": "test"}
    assert api.get_fx()["fx"]["usd_vnd"] == 25000.0
    # the Vilao mode of the Live tab: billed rows only, newest window, without touching the network
    billed = api.get_calls(billed=True, hours=2)["calls"]
    assert [r["bill_request_id"] for r in billed] == ["host"]
    assert billed[0]["bill_key_id"]
    assert api.get_calls(key_id="00000000-0000-4000-8000-000000000000", billed=True)["count"] == 1
    assert api.get_calls(key_id="nope", billed=True)["count"] == 0
    assert api.get_calls(hours=0.001)["count"] == 0


def test_a_billing_row_never_claims_a_profile(tmp_path):
    """Whichever home ran the ingest did not necessarily make the call, so a charge carries no home.

    Before this rule existed every account-level charge was filed under whichever home booted first --
    one profile's label on the whole account's spending, which is how the Live
    tab came to report the wrong profile for nearly every row it showed.
    """
    home_a = tmp_path / "profiles" / "alpha"
    home_a.mkdir(parents=True)
    _close_everything()
    for stale in ("rw_store", "rw_bill"):
        sys.modules.pop(stale, None)
    store, bill = _load("rw_store", PLUGIN_ROOT / "usage_store.py"), _load("rw_bill", PLUGIN_ROOT / "usage_bill.py")
    os.environ["HERMES_HOME"] = str(home_a)
    now = time.time()
    _local(store, now - 10, model="nvidia/nim-foo")
    _bill(bill, store, now - 5, rid="unattributed-1", cost=99.0)
    rows = store.recent(limit=10)
    assert [r["profile"] for r in rows if r["source"] == "hook"] == ["alpha"], rows
    assert [r["profile"] for r in rows if r["source"] == "bill"] == [""], rows
    # the filter has to reach both buckets, or the billing history becomes invisible
    assert store.recent(profile=store.NO_PROFILE) == [r for r in rows if r["source"] == "bill"]
    assert len(store.recent(profile="alpha")) == 1
    assert len(store.recent()) == 2
    counts = {p["profile"]: p["calls"] for p in store.profiles_seen()}
    assert counts == {"alpha": 1, "": 1}, counts
    assert store.recent_count() == 2 and store.recent_count(profile="alpha") == 1


def test_existing_billing_rows_are_blanketed_once(tmp_path):
    """The write path only fixes the future, so rows stored by the old build are corrected in place."""
    home = tmp_path / "profiles" / "alpha"
    (home / "plugin-data" / "resetwatch").mkdir(parents=True)
    _close_everything()
    now = time.time()
    # a legacy store that carries a bill row stamped with the home that ingested it
    _write_legacy(home / "plugin-data" / "resetwatch" / "calls.sqlite", [
        (now - 30, "alpha", None, "vilao-ai", "cx/gpt-6-astra", 1100, 500.0, "old-1",
         "bill_only", None, "bill")])
    os.environ["HERMES_HOME"] = str(tmp_path)
    for stale in ("rw_store", "rw_bill"):
        sys.modules.pop(stale, None)
    store = _load("rw_store_blank", PLUGIN_ROOT / "usage_store.py")
    rows = store.recent(limit=10)
    assert len(rows) == 1, rows
    assert rows[0]["profile"] == "", rows
    assert rows[0]["source"] == "bill"
    conn = store._connect(store.store_path())
    assert store._unattribute_bill_rows(conn) == 0, "the fix re-ran on every connect"


def test_day_bucket_matches_the_sql_expression(tmp_path):
    """The stored bucket must agree with date(ts,'unixepoch','localtime') to the day.

    Every day-bucketed view now reads the column, so a row whose bucket disagrees with the expression
    would land in the wrong square of the Trend grid -- and a row whose bucket is missing at all would
    vanish from it entirely.
    """
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    stamps = [now, now - 3600, now - 86400 * 3, now - 86400 * 40]
    for ts in stamps:
        _local(store, ts, model="vilao-ai/alic/glm-5.1")
    conn = store._connect(store.store_path())
    stored = {r["ts"]: r["day"] for r in conn.execute("SELECT ts, day FROM calls")}
    for ts in stamps:
        want = time.strftime("%Y-%m-%d", time.localtime(ts))
        assert stored[ts] == want, (ts, stored[ts], want)
    # and the aggregate agrees with the expression it replaced
    bucket = {r["day"]: r["calls"] for r in conn.execute("SELECT day, COUNT(*) AS calls FROM calls GROUP BY day")}
    expr = {r[0]: r[1] for r in conn.execute(
        "SELECT date(ts,'unixepoch','localtime'), COUNT(*) FROM calls GROUP BY 1")}
    assert bucket == expr, (bucket, expr)
    # the day query must be able to use an index, or the column buys nothing. The plan detail is the last
    # column of each row -- str() on a Row object prints the object, not the plan.
    plan = " ".join(r[-1] for r in conn.execute(
        "EXPLAIN QUERY PLAN SELECT day, COUNT(*) FROM calls GROUP BY day"))
    assert "idx_calls_day" in plan, plan
    range_plan = " ".join(r[-1] for r in conn.execute(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM calls WHERE day >= '2020-01-01'"))
    assert "idx_calls_day" in range_plan, range_plan


def test_a_store_without_day_gets_it_backfilled(tmp_path):
    """An old file gains the column and every existing row gains a bucket, once."""
    home = tmp_path / "profiles" / "alpha"
    (home / "plugin-data" / "resetwatch").mkdir(parents=True)
    _close_everything()
    now = time.time()
    _write_legacy(home / "plugin-data" / "resetwatch" / "calls.sqlite",
                  [(now - i * 60, "alpha", "s%d" % i, "nvidia", "nvidia/nim-foo", 500, None, None,
                    "local_only", None, "hook") for i in range(4)])
    os.environ["HERMES_HOME"] = str(tmp_path)
    for cached in ("rw_store", "rw_bill"):
        sys.modules.pop(cached, None)
    store = _load("rw_store_day", PLUGIN_ROOT / "usage_store.py")
    rows = store.daily(2)
    assert sum(int(r["calls"]) for r in rows) == 4, rows
    conn = store._connect(store.store_path())
    assert conn.execute("SELECT COUNT(*) FROM calls WHERE day IS NULL").fetchone()[0] == 0
    # rows written afterwards carry the bucket without another migration
    _local(store, time.time())
    assert conn.execute("SELECT COUNT(*) FROM calls WHERE day IS NULL").fetchone()[0] == 0


def test_sessions_rollup_only_reads_rows_that_have_a_session(tmp_path):
    """Per-session totals come from the hook log; a billing row has no session and must not appear.

    The helper that writes local calls uses one session id, so the two sessions here are written through
    the store directly -- and the point is the shape of the rollup, not the id.
    """
    store, bill = fresh_store(str(tmp_path))
    now = time.time()

    def call(sid, model, mins_ago):
        return store.record_local(ts=now - mins_ago * 60, payload={
            "session_id": sid, "platform": "cli", "provider": "nvidia", "model": model,
            "finish_reason": "stop", "usage": {"input_tokens": 1000, "output_tokens": 100}})

    call("s-a", "nvidia/nim-foo", 30)
    call("s-a", "nvidia/nim-bar", 25)
    call("s-b", "kilocode/free", 20)
    _bill(bill, store, now - 10 * 60, rid="bill-no-session", cost=77.0)

    rows = store.sessions(2)
    by = {r["session_id"]: r for r in rows}
    assert set(by) == {"s-a", "s-b"}, by                      # the billing row is not a session
    assert int(by["s-a"]["calls"]) == 2 and int(by["s-a"]["models"]) == 2, by["s-a"]
    assert int(by["s-a"]["tokens"]) == 2200, by["s-a"]        # 2 x (1000 + 100)
    assert by["s-a"]["profile"], by["s-a"]                    # the home is the hook row's own
    assert float(by["s-b"]["dong"]) == 0.0, by["s-b"]         # no bill paired inside the session
    assert all(r["session_id"] for r in rows), rows
    assert store.stats()["rows"] == 4, store.stats()          # 3 hook + 1 bill


def test_usage_by_model_reports_the_billing_token_shape(tmp_path):
    """tok_billed is in+out+cache read, which is what the dong is divided by on the invoice.

    A call whose input was cached arrives from Hermes as input+output and from the bill as
    in+out+cache read -- the local total excludes the cached input the provider still charges.
    """
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    conn = store._connect(store.store_path())
    store.record_local(ts=now - 10, payload={
        "session_id": "s1", "provider": "vilao-ai", "model": "vilao-ai/alic/glm-5.1",
        "finish_reason": "stop",
        "usage": {"input_tokens": 5000, "output_tokens": 250, "cache_read_input_tokens": 20000}},
        est_cost_usd=0.01)
    rows = store.usage_by_model(days=2)
    assert len(rows) == 1, rows
    r = rows[0]
    assert int(r["tok_in"]) == 5000 and int(r["tok_out"]) == 250 and int(r["tok_cache"]) == 20000
    assert int(r["tokens"]) == 5250, r              # the local shape
    assert int(r["tok_billed"]) == 25250, r        # the billed shape
    assert conn.execute("SELECT COUNT(*) FROM calls WHERE day IS NULL").fetchone()[0] == 0


def test_a_calendar_square_asks_for_exactly_one_day(tmp_path):
    """Clicking a day in the year grid must return that day's rows and nothing else.

    The filter is on the stored ``day`` bucket, not a ts range, so the local midnight boundary is the
    same one the grid drew -- and the pair of stamps here is pinned to noon so a test run at 23:59
    cannot make yesterday look like today.
    """
    store, _bill = fresh_store(str(tmp_path))
    noon = time.mktime(time.strptime(time.strftime("%Y-%m-%d") + " 12:00:00", "%Y-%m-%d %H:%M:%S"))
    today, yday = store.day_of(noon), store.day_of(noon - 86400)
    _local(store, noon, model="vilao-ai/cx/gpt-6-astra")
    _local(store, noon - 60, model="vilao-ai/alic/glm-5.1")
    _local(store, noon - 86400, model="vilao-ai/alic/glm-5.1")
    assert {r["model_key"] for r in store.recent(day=today)} == {
        "cx/gpt-6-astra", "alic/glm-5.1"}, store.recent(day=today)
    assert {r["model_key"] for r in store.recent(day=yday)} == {"alic/glm-5.1"}
    assert store.recent_count(day=today) == 2 and store.recent_count(day=yday) == 1
    assert store.recent_count() == 3
    # a day filter has to be able to use the index, or the click costs a whole-table scan
    conn = store._connect(store.store_path())
    plan = " ".join(r[-1] for r in conn.execute(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM calls WHERE day='2026-01-01'"))
    assert "idx_calls_day" in plan, plan


def test_the_route_refuses_a_day_that_is_not_a_day():
    """2026-02-30 has the right shape and does not exist; "no calls" would be a wrong answer."""
    from fastapi import HTTPException

    api = _load("rw_api_day", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    for bad in ("2026-02-30", "2026-13-01", "yesterday", "2026-1-1", "2026-10-09 OR 1=1"):
        try:
            api.get_calls(day=bad)
        except HTTPException as exc:
            assert exc.status_code == 400, (bad, exc.status_code)
        else:
            raise AssertionError("accepted day %r" % bad)


def test_the_price_watch_only_answers_if_yesterday_was_written_down(tmp_path):
    """The catalogue is the only place that says what a model costs, so the store has to remember it.

    The comparison is per offer key (provider + model), not per model name -- the same model is sold by a
    dozen providers at different prices -- and on the net price, because a promo ending is a rise.
    """
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    yesterday = store.day_of(now - 86400)
    offer = {"key": "dogi/glm-5.3", "id": "glm-5.3", "provider": "dogi", "in": 200.0, "out": 1000.0,
             "cache_read": 100.0, "context": 1000000, "floor": 5.0, "promo_off": 0}
    assert store.record_catalog([offer]) == 1
    assert store.catalog_changes()["count"] == 0, "one snapshot cannot disagree with anything"
    assert store.record_catalog([dict(offer, **{"in": 210.0})]) == 1, "the same day was stored twice"
    conn = store._connect(store.store_path())
    assert conn.execute("SELECT COUNT(*) FROM catalog_prices").fetchone()[0] == 1
    # a re-read inside one day overwrites that day's price: the watch is daily by construction, and a
    # second fetch of the same afternoon is not a price event
    assert conn.execute("SELECT price_in FROM catalog_prices").fetchone()[0] == 210.0
    conn.execute("UPDATE catalog_prices SET day=?", (yesterday,))
    store.record_catalog([dict(offer, promo_off=50.0, promo_in=100.0)])   # half price, net 100
    ch = store.catalog_changes()
    assert ch["days"] == [store.day_of(now), yesterday], ch["days"]
    moved = [c for c in ch["rows"] if c["kind"] == "price"]
    assert len(moved) == 1, len(ch["rows"])
    assert moved[0]["from"] == 210.0 and moved[0]["to"] == 100.0, (moved[0]["from"], moved[0]["to"])
    assert abs(moved[0]["pct"] - (100.0 - 210.0) / 210.0 * 100.0) < 0.01, moved[0]["pct"]
    # an offer that vanishes from the marketplace is the more expensive of the two answers: leave one
    # row dated yesterday that today's snapshot no longer holds, then add one today that yesterday had
    store.record_catalog([dict(offer, key="anvil/old-model", id="old-model", provider="anvil")])
    conn.execute("UPDATE catalog_prices SET day=? WHERE key='anvil/old-model'", (yesterday,))
    store.record_catalog([dict(offer, key="chipu/glm-5.3", provider="chipu")])
    kinds = {c["kind"] for c in store.catalog_changes()["rows"]}
    assert {"new", "gone", "price"} <= kinds, sorted(kinds)


def test_route_refuses_a_key_id_that_is_not_an_id():
    """key_id is pasted into an endpoint path this module authenticates with a spend-capable token."""
    api = _load("rw_api_keys", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    from fastapi import HTTPException

    for bad in ("../usage", "00000000-0000-4000-8000-0000000000fe?x=1", "", "a b", "x" * 200):
        try:
            api.get_key_detail(key_id=bad)
        except HTTPException as exc:
            assert exc.status_code == 400, (bad, exc.status_code)
        else:
            raise AssertionError("accepted key_id %r" % bad)
    assert api.KEY_ID_RE.match("00000000-0000-4000-8000-0000000000fe")
    assert api.KEY_ID_RE.match("sk_1-2_3")


def test_bill_get_will_not_carry_the_token_offsite():
    """Absolute paths are allowed for the v1 marketplace; other hosts are refused before a header exists."""
    bill = _load("rw_bill_hosts", PLUGIN_ROOT / "usage_bill.py")
    called = []
    real = bill.httpx.get

    def spy(url, *a, **kw):
        called.append(url)
        raise AssertionError("must not reach the network for a refused host")
    bill.httpx.get = spy
    try:
        for bad in ("https://evil.example/api", "http://vilao.ai/api/v2/account/balance",
                    "https://vilao.ai.evil.example/x"):
            try:
                bill._get(bad)
            except ValueError:
                continue
            raise AssertionError("accepted %r" % bad)
        assert called == [], called
    finally:
        bill.httpx.get = real


class _Envelope:
    """A fake httpx response in the shape both vilao pages answer with: an envelope holding ``data``."""

    status_code = 200

    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return {"data": self._data}


def test_the_public_price_list_is_fetched_without_a_credential(monkeypatch):
    """The marketplace page needs no token, so no token may ever be attached to it.

    Two different failures lived in that one rule, and both are the reader's. Someone who HAS a PAT was
    sending a full-scope, spend-capable credential to a route that never asks for one; someone with NO
    PAT could not read the price list at all, because the authenticated client raises before it starts.
    """
    bill = _load("rw_bill_keyless", PLUGIN_ROOT / "usage_bill.py")
    seen = []

    def spy(url, params=None, **kw):
        seen.append((url, params, kw))
        return _Envelope([{"model_id": "glm-5.3", "provider_prefix": "dogi"}])

    def no_secret_lookup():
        raise AssertionError("the keyless fetch resolved the PAT")

    monkeypatch.setattr(bill.httpx, "get", spy)
    monkeypatch.setattr(bill, "pat", no_secret_lookup)

    data = bill.public_get("https://vilao.ai/api/v1/llm/marketplace/models", {"page": 1, "limit": 100})

    assert data == [{"model_id": "glm-5.3", "provider_prefix": "dogi"}], data
    url, params, kw = seen[0]
    assert url == "https://vilao.ai/api/v1/llm/marketplace/models", url
    assert params == {"page": 1, "limit": 100}, params
    headers = kw.get("headers") or {}
    assert not any(str(k).lower() == "authorization" for k in headers), headers
    # The same https + host rules as the authenticated path: keyless is not the same as unvalidated.
    for bad in ("https://evil.example/api/v1/llm/marketplace/models",
                "http://vilao.ai/api/v1/llm/marketplace/models",
                "https://vilao.ai.evil.example/x"):
        try:
            bill.public_get(bad)
        except ValueError:
            continue
        raise AssertionError("accepted %r" % bad)
    assert len(seen) == 1, seen


def test_the_models_route_answers_with_no_pat_at_all(tmp_path, monkeypatch):
    """No credential is a working Models tab, not an unreachable catalogue.

    This is the shape a reviewer tests first: a fresh home, no billing account, open the price list. The
    route used to hand the catalogue ``bill._get``, which raises PermissionError for want of a token and
    came back as zero offers beside "catalog unreachable" -- a headline public feature dead for exactly
    the readers the README tells them it still works for.
    """
    _close_everything()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("VILAO_PAT", raising=False)
    api = _load("rw_api_catalog_nokey", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    # The premise, asserted rather than assumed: this profile genuinely has no token.
    assert api.bill.pat() is None

    offers = [{"model_id": "glm-5.3", "provider_prefix": "dogi", "price_per_input_token": 100.0,
               "price_per_output_token": 300.0, "max_context_length": 200000},
              {"model_id": "gpt-6-astra", "provider_prefix": "cx", "price_per_input_token": 250.0,
               "price_per_output_token": 1000.0, "max_context_length": 400000}]
    seen = []

    def spy(url, params=None, **kw):
        seen.append((url, kw))
        return _Envelope([] if (params or {}).get("page", 1) > 1 else offers)

    monkeypatch.setattr(api.bill.httpx, "get", spy)

    got = api.get_catalog()

    assert got["error"] is None, got
    assert got["count"] == 2, got
    assert [m["key"] for m in got["models"]] == ["dogi/glm-5.3", "cx/gpt-6-astra"], got["models"]
    assert seen, "the catalogue was never fetched"
    assert all(u.startswith("https://vilao.ai/api/v1/llm/marketplace/models") for u, _ in seen), seen
    assert not any(str(k).lower() == "authorization"
                   for _, kw in seen for k in (kw.get("headers") or {})), seen


def test_the_rollup_rebuilds_when_it_disagrees_with_the_calls(tmp_path):
    """No memo any more: the rollup is the cache, so it has to prove itself against the raw rows.

    ``rollup_consistent`` is the whole correctness argument -- a row written by an older build, a hand-edited
    file or a crash between an INSERT and its rebuild must all end in a rebuild rather than a wrong number.
    """
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 30)
    _bill(bill, store, now - 20, rid="r1", cost=19.4)
    conn = store._connect(store.store_path())
    assert store.ensure_rollups(conn) == "ok", "a healthy store was flagged"
    assert store.rollup_consistent(conn)
    conn.execute("INSERT INTO calls (ts, profile, source, model, model_key, day, tok_total) "
                 "VALUES (?, 'x', 'hook', 'm', 'm', ?, 5)", (now, store.day_of(now)))
    assert not store.rollup_consistent(conn), "a write that skipped touch_days went unnoticed"
    assert store.ensure_rollups(conn) == "rebuilt"
    assert store.rollup_consistent(conn)
    assert store.daily(2)[0]["calls"] == 3, store.daily(2)


def test_a_row_written_without_a_day_is_healed_then_counted(tmp_path):
    """An older build in a long-lived process keeps writing rows whose INSERT has no ``day``.

    An older build in a long-lived process keeps writing rows whose INSERT has no ``day``, and a handful
    of them leaves the rollup permanently short of the call count -- which is the failure an incremental
    cache cannot see: every reader agreed with the rollup and
    disagreed with the invoice. The repair runs on the drain tick, and the fingerprint only counts the
    domain a day-keyed rollup can describe so the check converges instead of rebuilding forever.
    """
    store, _bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 10)
    conn = store._connect(store.store_path())
    conn.execute("UPDATE calls SET day = NULL")          # emulate the previous build's row shape
    conn.execute("INSERT INTO calls (ts, profile, source, model, model_key, tok_total) "
                 "VALUES (?, 'x', 'hook', 'm', 'm', 7)", (now,))
    assert store._rollup_state(conn).split("|")[0] == "0", store._rollup_state(conn)
    assert store._backfill_day(conn) == 2, "the once-per-store flag blinded the repair"
    assert conn.execute("SELECT COUNT(*) FROM calls WHERE day IS NULL").fetchone()[0] == 0
    assert store._rollup_state(conn).split("|")[0] == "2", store._rollup_state(conn)
    assert store.ensure_rollups(conn) == "rebuilt"
    assert store.ensure_rollups(conn) == "ok", "the check never converged"
    assert store.stats()["rows"] == 2 and store.daily(2)[0]["calls"] == 2, store.daily(2)


def test_model_totals_can_be_filtered_by_feed(tmp_path):
    """The Log tab shows the Hermes feed and the bill feed separately; the rollup has to keep them apart.

    day_model_stats is keyed (day, profile, source, model_key), so one model used through both feeds is two
    rows -- which is only correct if the readers re-sum them and the provider list survives the split.
    """
    store, bill = fresh_store(str(tmp_path))
    now = time.time()
    _local(store, now - 30, model="vilao-ai/cx/gpt-6-astra")
    _bill(bill, store, now - 20, model="cx/gpt-6-astra", rid="s1", cost=19.4)
    every = store.usage_by_model(days=2)
    assert len(every) == 1, every
    assert int(every[0]["calls"]) == 2, every[0]
    hooks = store.usage_by_model(days=2, source="hook")
    bills = store.usage_by_model(days=2, source="bill")
    assert [int(r["calls"]) for r in hooks] == [1], hooks
    assert [int(r["calls"]) for r in bills] == [1], bills
    assert float(bills[0]["dong"]) == 19.4, bills[0]
    assert every[0]["providers"] == "vilao-ai", every[0]


def test_the_same_file_reached_by_two_paths_boots_once(tmp_path):
    """Backslash and forward-slash spellings of the store are one database, not two boots."""
    store = _load("rw_store_alias", PLUGIN_ROOT / "usage_store.py")
    home = tmp_path / "plugin-data" / "call-ledger"
    home.mkdir(parents=True)
    path = str(home / "calls.sqlite")
    a = store._connect(path)
    alias = store._connect(path.replace("\\", "/"))
    assert a is alias, "an aliased path opened a second connection"
    assert len(store._booted) == 1, store._booted


if __name__ == "__main__":
    import tempfile

    # The Windows console is cp1252 here, and a failing assertion whose message carries Vietnamese
    # (a store label, a payload dict) would die on UnicodeEncodeError inside the print -- the failure
    # would be real and invisible. UTF-8 with replacement keeps the report readable either way.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    failures = 0
    cases = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_")]
    for name, fn in cases:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            from pathlib import Path as _P

            try:
                for stale in ("rw_api_isolated", "call_ledger_usage_store", "call_ledger_usage_bill"):
                    sys.modules.pop(stale, None)
                if fn.__code__.co_argcount == 1:
                    fn(_P(tmp))
                else:
                    fn()
                print("PASS %s" % name)
            except Exception as exc:
                failures += 1
                import traceback

                print("FAIL %s: %s" % (name, exc))
                traceback.print_exc()
            finally:
                _close_everything()
    print("cases=%d failures=%d" % (len(cases), failures))
    sys.exit(1 if failures else 0)
