"""Identity gate: the manifest name, the desktop PLUGIN_ID and the store dir must be one string.

A mismatch is not cosmetic: the dashboard drops a manifest whose name is not a known agent plugin
(spoof guard), and `ctx.rest` addresses /api/plugins/<id>/, so a drifting id 404s the whole page.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tools.scan_secrets import NOT_SHIPPED          # noqa: E402  (one scope list for every gate)

# The gate has to name what it forbids, and it reads the whole tree -- including this file. Adjacent
# literals join at compile time, so the source never holds a complete forbidden token while the
# comparison over the other files stays exact.
FORBIDDEN = ("hermes-reset" "watch", "PLUGIN_" "NAME = 'Usage'", "/" "reset" "watch")
# One exception, and it is asserted rather than skipped: the import glob that still finds stores written
# before the rename. Those files are the only record of charges from that period, so dropping the pattern
# would silently lose history. A comment marker on the same line is what whitelists it.
LEGACY_OK = "pre-rename stores"
LEGACY_STORE = "plugin-data/" "resetwatch"


def _tracked_text():
    for f in ROOT.rglob("*"):
        if not f.is_file() or f.suffix not in (".py", ".js", ".json", ".yaml", ".md"):
            continue
        rel = f.relative_to(ROOT).as_posix()
        if "__pycache__" in f.parts or any(rel.startswith(p) for p in NOT_SHIPPED):
            continue
        yield f, f.read_text(encoding="utf-8", errors="replace")


def test_no_private_identity_survives():
    """The whitelist is the store-directory spelling itself, never the comment alone.

    A marker-only exemption is an escape hatch: a line that carried `pre-rename stores` could have
    reintroduced the plugin id or the old route and passed this gate and the count test below both. So a
    line is exempt only when it names the old store directory *and* carries the marker, and there is
    exactly one such line -- the reader glob that still imports stores written before the rename.
    """
    exempt, bad = [], []
    for f, text in _tracked_text():
        for i, line in enumerate(text.splitlines()):
            if not any(b in line for b in FORBIDDEN):
                continue
            where = (f.relative_to(ROOT).as_posix(), i + 1)
            (exempt if LEGACY_STORE in line and LEGACY_OK in line else bad).append(where)
    assert bad == [], bad
    assert len(exempt) == 1, exempt
    assert exempt[0][0] == "usage_store.py", exempt


def test_the_legacy_import_glob_is_the_only_old_name_left():
    """Whitelisting without an escape hatch: exactly one line may still name the old store dir."""
    hits = [(f.relative_to(ROOT).as_posix(), i + 1) for f, text in _tracked_text()
            for i, line in enumerate(text.splitlines())
            if LEGACY_STORE in line]
    assert len(hits) == 1, hits
    assert LEGACY_OK in next(
        (ln for ln in (ROOT / hits[0][0]).read_text(encoding='utf-8').splitlines()
         if LEGACY_STORE in ln))


def test_identity_is_one_string_across_surfaces():
    manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    js = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    dash = (ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8")
    name = re.search(r'"name":\s*"([^"]+)"', manifest).group(1)
    pid = re.search(r"const PLUGIN_ID = '([^']+)'", js).group(1)
    dname = re.search(r'"name":\s*"([^"]+)"', dash).group(1)
    assert name == pid == dname == "hermes-call-ledger", (name, pid, dname)


def test_store_is_under_the_plugin_id_dir():
    src = (ROOT / "usage_store.py").read_text(encoding="utf-8")
    assert '"plugin-data", "call-ledger", "calls.sqlite"' in src
    assert 'profiles/*/plugin-data/call-ledger/calls.sqlite' in src


# The manifest speaks for whoever publishes the repository. Written in two literals so this file -- the
# gate that forbids naming third parties -- does not carry the handle either: `plugin.yaml`'s `author`
# field stays the one place the published tree names a person.
MAINTAINER = "sk" "appafrost"


def test_author_is_the_maintainer_and_names_no_third_party():
    """A renamed plugin published under somebody else's handle is a misattribution.

    The manifest is what the catalog shows as the author and what a reader holds the publisher to, so it
    can only name the person who owns the published repository. Lineage credit is README copy (Task 9),
    not an identity claim in a manifest field.
    """
    manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    author = re.search(r'"author":\s*"([^"]*)"', manifest).group(1)
    assert author == MAINTAINER, author
    # One handle and nothing else: no upstream name, no "et al.", no organisation, no e-mail address.
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{1,38}", author), author
    assert ("Adol" "anium") not in manifest, "lineage belongs in the README, not in the manifest"
