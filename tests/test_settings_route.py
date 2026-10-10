"""`GET /settings`: the page's three readable settings, and nothing else.

The route is the only place the desktop page learns its language, its money unit and how deep the first
bill walk should go, so it has to answer on a machine where nothing is configured -- a 500 here is a page
that never paints. It also has to be the place a secret cannot leak from: `vilao_pat` is declared in the
same manifest and lives in the home's `.env`, and a settings route that echoed the entry it read would
print a credential into the desktop renderer's query cache.

The route is loaded by path exactly the way the dashboard mounts it (`plugins.isolation: host` gives it
no parent package), and `_plugin_settings` is monkeypatched, so these tests never read a real config.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from ruamel.yaml import YAML

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_env import bootstrap_sys_path          # noqa: E402
bootstrap_sys_path()


def _manifest() -> dict:
    """`plugin.yaml` through the loader the Hermes plugin host itself uses (ruamel, `fast_safe_load`).

    PyYAML is not a dependency of this plugin or of the host, so the test that compares the manifest with
    the route must not be the thing that quietly adds it.
    """
    return YAML(typ="safe").load((PLUGIN_ROOT / "plugin.yaml").read_text(encoding="utf-8"))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_settings_route_returns_the_three_values_with_defaults(tmp_path, monkeypatch):
    """Unset settings must answer with the manifest defaults, not 500 or absent keys."""
    api = _load("cl_api_settings", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    monkeypatch.setattr(api, "_plugin_settings", lambda: {})
    got = api.get_settings()
    assert got == {"language": "auto", "currency": "auto", "lookback_days": 30}, got


def test_settings_route_passes_configured_values(tmp_path, monkeypatch):
    api = _load("cl_api_settings2", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    monkeypatch.setattr(api, "_plugin_settings", lambda: {"language": "vi", "lookback_days": 90})
    assert api.get_settings() == {"language": "vi", "currency": "auto", "lookback_days": 90}


def test_settings_never_leaks_the_secret(tmp_path, monkeypatch):
    api = _load("cl_api_settings3", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    monkeypatch.setattr(api, "_plugin_settings", lambda: {"vilao_pat": "secret-value"})
    assert "vilao_pat" not in api.get_settings()
    assert "secret-value" not in repr(api.get_settings())


def test_the_route_defaults_are_the_manifest_defaults():
    """`plugin.yaml` and the route must not disagree about what an unset key means.

    The Plugins hub shows and writes the manifest's `default`; the page paints with the route's. Two
    numbers is one setting with two answers, and the drift is invisible until somebody changes one.
    """
    api = _load("cl_api_settings4", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    schema = _manifest()["config_schema"]
    assert api.DEFAULTS == {k: v["default"] for k, v in schema.items() if "default" in v}
    # The secret is declared, so the route has to name it as unreadable rather than pass it through.
    assert api.SECRET_KEYS == tuple(k for k, v in schema.items() if v.get("type") == "secret")


def test_the_page_has_one_settings_route(tmp_path):
    """One readable route, on the GET side, and it answers at `/settings`.

    The brief is "one `/settings` read route": a second one is how a page ends up asking two questions of
    two endpoints and painting from whichever answers last. POST /sync is the page's only write route and
    does not belong in this count.
    """
    api = _load("cl_api_settings5", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    got = [r.path for r in api.router.routes if "GET" in (r.methods or set())]
    assert got.count("/settings") == 1, got
    assert "/settings" in got, got


def test_the_reader_finds_the_dotpath_a_real_config_uses(tmp_path, monkeypatch):
    """`plugins.entries.<id>.settings` read through the public loader, not through a stub.

    The three tests above replace `_plugin_settings`, so they cannot prove the dotpath is the one the
    Plugins hub actually writes (`hermes_cli.plugins_state.save_plugin_setting`). This one writes a real
    config.yaml into a throwaway home and reads it back through `load_config_readonly`, which is also the
    shape the page sees on a machine where somebody has set a language -- and the secret sitting next to
    the settings in that same entry is the proof it never reaches the route.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "plugins:\n"
        "  entries:\n"
        "    hermes-call-ledger:\n"
        "      settings:\n"
        "        language: vi\n"
        "        lookback_days: 60\n"
        "        vilao_pat: never-returned\n",
        encoding="utf-8")
    api = _load("cl_api_settings6", PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    assert api.get_settings() == {"language": "vi", "currency": "auto", "lookback_days": 60}
    assert "never-returned" not in repr(api.get_settings())
    # An entry that does not exist at all is the default page, not an error.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "empty"))
    assert api.get_settings() == dict(api.DEFAULTS)
