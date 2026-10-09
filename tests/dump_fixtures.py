"""Build tests/fixtures.json from a THROWAWAY Hermes home, never from a live one.

The private version of this script pointed HERMES_HOME at a real profile and dumped the account. Two
things were wrong with that: a HERMES_HOME inside the install root resolves back to the root, so reading
the store also wrote into it, and the output was an account's spending history. Here the home is a
tempfile seeded with synthetic rows (tests/seed.py), the routes that would reach the network are answered
by stubs, and the whole run is offline -- which is also what makes it runnable in CI and on a machine
with no billing provider configured.

Run it with `py -3.13 tests/dump_fixtures.py` whenever a route's shape changes; the render harness and the
unit gate both read the file it writes.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from hermes_env import bootstrap_sys_path          # noqa: E402
import seed                                          # noqa: E402

bootstrap_sys_path()
OUT = HERE / "fixtures.json"

# A stand-in for "a PAT is configured", so the fixtures describe the richer shape: the routes answer the
# same fields they would for an account. It is not a credential and nothing here can be.
SYNTH_PAT = "synthetic-placeholder-token"

_NOW = time.time()
_ISO = lambda s: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(s))  # noqa: E731

_KEYS = [
    {"id": seed.KEY_ID, "name": "primary", "prefix": "0000", "active": True, "favorite": True,
     "rpm": 60, "requests": 1240, "spent": 4820.5, "created_at": _ISO(_NOW - 120 * 86400),
     "expires_at": None, "revoked_at": None, "models": 3, "content_filtered_last_at": None},
    {"id": seed.KEY_ID_2, "name": "bench", "prefix": "0002", "active": True, "favorite": False,
     "rpm": 20, "requests": 310, "spent": 610.0, "created_at": _ISO(_NOW - 60 * 86400),
     "expires_at": None, "revoked_at": None, "models": 2, "content_filtered_last_at": None},
]

_KEY_DETAIL = {
    "id": seed.KEY_ID, "name": "primary", "prefix": "0000", "active": True, "rpm": 60,
    "requests": 1240, "spent": 4820.5, "daily_budget": None, "monthly_budget": 20000.0,
    "daily_period_start": None, "daily_next_reset": None,
    "monthly_period_start": _ISO(_NOW - 3 * 86400), "monthly_next_reset": _ISO(_NOW + 27 * 86400),
    "created_at": _ISO(_NOW - 120 * 86400), "expires_at": None, "revoked_at": None,
}

_PRICE_BOOK = [
    {"model": "example/model-x", "provider": "example", "in": 200.0, "out": 800.0,
     "cache_read": None, "floor": 5.0, "promo_off": 50.0, "requests": 900, "spent": 3100.0,
     "tokens": 4100000, "active": True, "health": "healthy", "score": 92.0},
    {"model": "example/model-y", "provider": "example", "in": 120.0, "out": 480.0,
     "cache_read": None, "floor": None, "promo_off": 0.0, "requests": 340, "spent": 720.5,
     "tokens": 1200000, "active": True, "health": "degraded", "score": 61.0},
    {"model": "nvidia/nim-foo", "provider": "nvidia", "in": 0.0, "out": 0.0,
     "cache_read": None, "floor": None, "promo_off": 0.0, "requests": 12, "spent": 0.0,
     "tokens": 8000, "active": True, "health": "healthy", "score": 40.0},
]

_CATALOG = [
    {"key": "example/example/model-x", "id": "example/model-x", "name": "Model X",
     "provider": "example", "provider_name": "Example", "url": "https://vilao.ai/model/example/model-x",
     "seller": "example", "kind": "text", "mode": "chat", "context": 200000, "in": 200.0, "out": 800.0,
     "cache_read": 50.0, "cache_write": 250.0, "floor": 5.0, "promo_off": 50.0, "promo_in": 100.0,
     "promo_out": 400.0, "active": None, "recommended": True, "tools": True, "vision": True,
     "requests": 900, "success_rate": 99.2, "tps": 31.5, "latency_ms": 10675.0, "score": 92.0,
     "rating": 4.6, "verified": True},
    {"key": "example/example/model-y", "id": "example/model-y", "name": "Model Y",
     "provider": "example", "provider_name": "Example", "url": "https://vilao.ai/model/example/model-y",
     "seller": "example", "kind": "text", "mode": "chat", "context": 128000, "in": 120.0, "out": 480.0,
     "cache_read": 30.0, "cache_write": 150.0, "floor": None, "promo_off": 0.0, "promo_in": None,
     "promo_out": None, "active": None, "recommended": False, "tools": False, "vision": False,
     "requests": 340, "success_rate": 97.4, "tps": 48.0, "latency_ms": 2200.0, "score": 61.0,
     "rating": 4.1, "verified": True},
    {"key": "nvidia/nvidia/nim-foo", "id": "nvidia/nim-foo", "name": "NIM Foo",
     "provider": "nvidia", "provider_name": "Nvidia", "url": "https://vilao.ai/model/nvidia/nim-foo",
     "seller": "nvidia", "kind": "text", "mode": "chat", "context": 32000, "in": 0.0, "out": 0.0,
     "cache_read": None, "cache_write": None, "floor": None, "promo_off": 0.0, "promo_in": None,
     "promo_out": None, "active": None, "recommended": False, "tools": False, "vision": False,
     "requests": 12, "success_rate": 100.0, "tps": 12.0, "latency_ms": 900.0, "score": 40.0,
     "rating": None, "verified": False},
]

_TRANSACTIONS = [
    {"id": "topup-1", "status": "paid", "expected": 100000.0, "paid": 100000.0, "currency": "VND",
     "method": None, "created_at": _ISO(_NOW - 40 * 86400), "paid_at": _ISO(_NOW - 40 * 86400),
     "expires_at": None},
    {"id": "topup-2", "status": "paid", "expected": 50000.0, "paid": 50000.0, "currency": "VND",
     "method": None, "created_at": _ISO(_NOW - 12 * 86400), "paid_at": _ISO(_NOW - 12 * 86400),
     "expires_at": None},
    {"id": "topup-3", "status": "pending", "expected": 20000.0, "paid": 0.0, "currency": "VND",
     "method": None, "created_at": _ISO(_NOW - 3600), "paid_at": None,
     "expires_at": _ISO(_NOW + 1500)},
]

_ACCOUNT = {"active": True, "created_at": _ISO(_NOW - 400 * 86400), "email": "alpha@example.test",
            "last_activity_at": _ISO(_NOW - 60), "role": "user", "username": "alpha"}

_WALLET = {"balance": 14820.5, "used_balance": 320000.0, "withdrawable_balance": 0}

_FX = {"usd_vnd": 26200.0, "cny_vnd": 3900.0, "at": _NOW, "quote_time": _ISO(_NOW),
       "source": "synthetic"}


def _load_api(home: Path):
    os.environ["HERMES_HOME"] = str(home)
    path = seed.PLUGIN_ROOT / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("fx_api", path)
    api = importlib.util.module_from_spec(spec)
    sys.modules["fx_api"] = api
    spec.loader.exec_module(api)
    return api


def _stub_network(api) -> None:
    """Replace the four readers that would call vilao with the shapes they return.

    Assigning on the module objects is what the real routes call through, so everything around the
    network leg -- the join against the store, the price watch, the dong totals -- still runs for real.
    """
    api.bill.pat = lambda: SYNTH_PAT
    api.bill.account_snapshot = lambda: {"wallet": _WALLET, "pending_topups": [
        {"transaction_id": t["id"], "amount_expected": t["expected"], "currency": t["currency"],
         "created_at": t["created_at"], "expires_at": t["expires_at"]}
        for t in _TRANSACTIONS if t["status"] == "pending"], "keys": _KEYS}
    api.rd.keys = lambda get: list(_KEYS)
    api.rd.key_detail = lambda get, key_id: dict(_KEY_DETAIL)
    api.rd.key_models = lambda get, key_id: [dict(m) for m in _PRICE_BOOK]
    api.rd.transactions = lambda get, pages=1: [dict(t) for t in _TRANSACTIONS]
    api.rd.me = lambda get: dict(_ACCOUNT)
    api.rd.catalog = lambda get, force=False: {"models": [dict(m) for m in _CATALOG],
                                               "count": len(_CATALOG), "at": _NOW, "source": "synthetic"}
    api.fx.rates = lambda: dict(_FX)


def build(home: Path) -> dict[str, Any]:
    api = _load_api(home)
    _stub_network(api)
    keys_id = _KEYS[0]["id"]
    return {
        "calls": api.get_calls(per=100, page=1),
        "callsPage2": api.get_calls(per=100, page=2),
        "vilaoCalls": api.get_calls(per=100, page=1, billed=True),
        "summary365": api.get_summary(days="365"),
        "summary": api.get_summary(days="30"),
        "summaryHook": api.get_summary(days="30", source="hook"),
        "log": api.get_log(days="30", source="hook"),
        "logAll": api.get_log(days="365"),
        "sessions": api.get_sessions(days="30"),
        "rate": api.get_rate(hours=24),
        "keys": api.get_keys(),
        "keyDetail": api.get_key_detail(key_id=keys_id),
        "topups": api.get_topups(),
        "profiles": api.get_profiles(),
        "fx": api.get_fx(),
        "catalog": api.get_catalog(),
        "balance": api.get_balance(),
        "health": api.get_health(),
    }


def _neutralize(obj: Any, home: Path) -> Any:
    """Rewrite the temporary home's absolute path out of the payloads.

    Two routes echo the store path back to the page (``/profiles`` and ``/summary``'s ``store_root``), and
    dumping it verbatim would bake one machine's directory into a committed fixture -- and make the file
    differ on every run. A placeholder keeps the shape (a path-like string) and the reproducibility.
    """
    spellings = {str(home), str(home.resolve()), home.as_posix()}
    spellings = {s for s in spellings if s}

    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, str):
            for s in spellings:
                v = v.replace(s, "<fixture-home>")
            return v
        return v

    return walk(obj)


def main() -> int:
    home = Path(tempfile.mkdtemp(prefix="call-ledger-fixture-"))
    previous = os.environ.get("HERMES_HOME")
    try:
        seed.seed(home)
        out = _neutralize(build(home), home)
    finally:
        # An open SQLite handle blocks the temp dir from going away on Windows.
        for module in list(sys.modules.values()):
            closer = getattr(module, "close_connections", None)
            if callable(closer):
                closer()
        if previous is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = previous
        import shutil

        shutil.rmtree(home, ignore_errors=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("fixtures: %d routes -> %s (%d bytes)" % (len(out), OUT.name, OUT.stat().st_size))
    print("sizes:", {k: len(json.dumps(v, ensure_ascii=False)) for k, v in sorted(out.items())})
    return 0


if __name__ == "__main__":
    sys.exit(main())
