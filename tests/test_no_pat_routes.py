"""What a fresh install with no billing credential actually gets, route by route.

The README asks a reader to install before they decide, and the honest question is what the page does on
a machine that has never had a vilao account. So this is a sweep rather than a story: every published
route is called on a seeded throwaway home with no token anywhere, and the routes split into the two
classes they have to split into.

Local routes -- the call log, the aggregates, the settings, the price list -- must answer. A 500 there is
a tab that never paints, which is the worst way for a first run to go.

Credential routes -- balance, keys, key detail, top-ups, the bill pull -- must refuse with 401 and name
``VILAO_PAT``. Anything else is a bug in one of two directions: a route that answers as if it had data it
never fetched, or a raise that reaches the renderer as a crash instead of a message.

Nothing here touches the network: the transport is spied, and the request the catalogue does make is
checked for the header that must not be on it.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_env import bootstrap_sys_path  # noqa: E402
from seed import KEY_ID, seed  # noqa: E402

bootstrap_sys_path()

# (route as published, function, kwargs a fresh desktop page sends). Hand-written on purpose: a list
# derived from the router would silently grow when a route is added, and the new one would be swept by
# whatever class its neighbours fell into rather than by a decision.
LOCAL_ROUTES = [
    ("/settings", "get_settings", {}),
    ("/health", "get_health", {}),
    ("/calls", "get_calls", {}),
    ("/calls?day=", "get_calls", {"day": None}),
    ("/fx", "get_fx", {}),
    ("/rate", "get_rate", {}),
    ("/catalog", "get_catalog", {}),
    ("/matrix", "get_matrix", {}),
    ("/summary", "get_summary", {}),
    ("/log", "get_log", {}),
    ("/sessions", "get_sessions", {}),
    ("/profiles", "get_profiles", {}),
]
CREDENTIAL_ROUTES = [
    ("/keys", "get_keys", {}),
    ("/keys/detail", "get_key_detail", {"key_id": KEY_ID}),
    ("/topups", "get_topups", {}),
    ("/balance", "get_balance", {}),
    ("/sync", "post_sync", {"pulse": True}),
]


def _close_everything():
    for module in list(sys.modules.values()):
        closer = getattr(module, "close_connections", None)
        if callable(closer) and getattr(module, "__file__", "").startswith(str(PLUGIN_ROOT)):
            closer()


def _bare_home(tmp_path, monkeypatch):
    """A seeded store under a temp home, with no credential by any of the three routes to one."""
    _close_everything()
    seed(Path(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("VILAO_PAT", raising=False)
    for env_file in (Path(tmp_path) / ".env", Path(tmp_path) / "profiles" / ".env"):
        if env_file.exists():
            env_file.unlink()
    spec = importlib.util.spec_from_file_location(
        "cl_api_nokey_sweep", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    sys.modules["cl_api_nokey_sweep"] = api
    spec.loader.exec_module(api)
    return api


def _spy_transport(api, sink):
    """Replace the one httpx module so no request leaves the process, and record what was attempted."""
    class _Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"data": []}

    def get(url, params=None, **kw):
        sink.append((url, sorted(str(k) for k in (kw.get("headers") or {}))))
        return _Resp()

    def client(*a, **kw):
        raise AssertionError("the sweep must not build an authenticated client without a token")

    api.bill.httpx.get = get
    api.bill.httpx.Client = client


def test_no_credential_still_leaves_every_local_route_answering(tmp_path, monkeypatch):
    api = _bare_home(tmp_path, monkeypatch)
    attempted = []
    _spy_transport(api, attempted)
    assert api.bill.pat() is None, "the premise: this home genuinely has no token"

    for route, fn_name, kw in LOCAL_ROUTES:
        got = getattr(api, fn_name)(**kw)
        assert isinstance(got, dict), "%s returned %r" % (route, type(got))
        if "error" in got:
            assert got["error"] is None, "%s reported %r" % (route, got["error"])
    _close_everything()


def test_the_credential_routes_refuse_with_401_and_name_the_variable(tmp_path, monkeypatch):
    from fastapi import HTTPException

    api = _bare_home(tmp_path, monkeypatch)
    _spy_transport(api, [])
    refused = []
    for route, fn_name, kw in CREDENTIAL_ROUTES:
        with pytest.raises(HTTPException) as caught:
            getattr(api, fn_name)(**kw)
        assert caught.value.status_code == 401, "%s -> HTTP %s" % (route, caught.value.status_code)
        assert "VILAO_PAT" in str(caught.value.detail), route
        refused.append(route)
    assert len(refused) == len(CREDENTIAL_ROUTES), refused
    _close_everything()


def test_the_only_request_a_credential_less_home_makes_is_the_keyless_one(tmp_path, monkeypatch):
    """A home with no token must send no credential anywhere -- there is none to send, and the marketplace
    never asked for one. The catalogue is the single route allowed to reach out."""
    api = _bare_home(tmp_path, monkeypatch)
    attempted = []
    _spy_transport(api, attempted)
    for _route, fn_name, kw in LOCAL_ROUTES:
        getattr(api, fn_name)(**kw)
    authed = [(u, h) for u, h in attempted if h]
    assert authed == [], "requests that attached headers: %r" % (authed,)
    assert attempted, "the catalogue was never fetched, so this proves nothing about its headers"
    hosts = sorted({u.split("/api/")[0] for u, _ in attempted})
    assert all(h.startswith("https://") for h in hosts), hosts
    _close_everything()
