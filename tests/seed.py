"""Synthetic ledger rows for a throwaway Hermes home: two profiles and one billing feed.

The harnesses need the *shapes* the routes serve. Dumping a live store would put an account's charges and
key ids into a public repo, and it would move under the suite between runs, so every row here is made up.
They are still written through the plugin's own store and bill mapping rather than hand-written as JSON:
that is what keeps the fixtures honest -- when a route's shape changes, this stops matching it here instead
of quietly rotting the render harness.

``alpha`` and ``beta`` are the two profile names every fixture and docstring in this repo uses. They are
not real homes: `seed()` only ever points HERMES_HOME at directories under the temporary home it is given.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent

PROFILES = ("alpha", "beta")
# Placeholder ids in the shape vilao uses; no real key, user or provider is named anywhere in this file.
KEY_ID = "00000000-0000-4000-8000-000000000000"
KEY_ID_2 = "00000000-0000-4000-8000-000000000002"

# (model key as the log reports it, billed token shape, dong per charge) -- three offers so the day x
# model matrix has more than one column and the per-key split has more than one row.
OFFERS = (("example/model-x", 1100, 19.4),
          ("example/model-y", 560, 6.2),
          ("nvidia/nim-foo", 900, 0.0))

DAY = 86400.0
SPAN_DAYS = 10


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _payload(ts: float, model: str, tok_in: int, tok_out: int, *, session: str,
             provider: str, error: bool = False, task: Any = None) -> dict[str, Any]:
    """A hook payload in the shape ``record_local`` reads, i.e. what the observer hook is handed."""
    return {"session_id": session, "platform": "cli", "provider": provider, "model": model,
            "api_mode": "chat_completions", "finish_reason": "error" if error else "stop",
            "context_length": 200000, "usage": {"input_tokens": tok_in, "output_tokens": tok_out},
            "api_duration": 1.5, "started_at": ts - 1.5, "ended_at": ts, "first_chunk_at": ts - 0.5,
            "task": task}


def _bill_item(ts: float, model: str, tokens: int, cost: float, key: str, rid: str) -> dict[str, Any]:
    """One ``/llm/usage`` element, in the shape tests/fixtures/usage_item.json records."""
    return {"id": rid, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
            "actual_model": model, "model_id": model, "total_tokens": tokens, "total_cost": cost,
            "consumer_key_id": key, "input_tokens": int(tokens * 0.9),
            "output_tokens": int(tokens * 0.1), "cache_read_input_tokens": 120,
            "reasoning_tokens": 5, "latency_ms": 1500, "time_to_first_token_ms": 600,
            "success": True, "provider_type": "openai", "request_type": "chat", "stream": True}


def seed(home: Path) -> str:
    """Write calls for both profiles under ``home`` and return the store path.

    HERMES_HOME is moved between the two profile homes because that is how a row gets its ``profile``:
    the store reads the acting home at write time, so a seed that never moved it would tag every call to
    one home and the profile split the page draws would be a single row.
    """
    home = Path(home)
    store = _load("seed_store", "usage_store.py")
    bill = _load("seed_bill", "usage_bill.py")
    now = time.time()
    for p, (model, tokens, cost) in enumerate(OFFERS):
        provider = "vilao-ai" if p < 2 else "nvidia"
        for day in range(SPAN_DAYS):
            for slot in range(3):
                profile = PROFILES[(day + slot) % 2]
                ts = now - day * DAY - slot * 3600.0
                os.environ["HERMES_HOME"] = str(home / "profiles" / profile)
                error = (day == 2 and slot == 1)
                store.record_local(
                    ts=ts,
                    payload=_payload(ts, "%s/%s" % (provider, model), 900 + slot * 40, 90 + slot,
                                     session="%s-s%d" % (profile, day % 3 + 1), provider=provider,
                                     error=error, task="compression" if slot == 4 else None),
                    est_cost_usd=0.0042 if not error else None)
                if day < 5 and slot < 2:
                    # A billed charge for the same offer: match_rows pairs it to the nearest call, so the
                    # dong ends up on the call row exactly the way the page expects.
                    store.record_bill_rows([bill.to_row(_bill_item(
                        ts + 2.0, model, tokens, cost, KEY_ID if slot == 0 else KEY_ID_2,
                        "synthetic-%d-%d-%d" % (day, slot, p)))])
    store.match_rows()
    path = store.store_path()
    store.close_connections()
    return path
