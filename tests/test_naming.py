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
# would silently lose history. Only that exact spelling, with the marker on its own line, is whitelisted.
LEGACY_OK = "pre-rename stores"
# The old store directory, assembled from pieces so that this file is not a hit for its own count.
STORE_DIR = "plugin-" "data"
OLD_STORE_NAME = "reset" "watch"
LEGACY_STORE = STORE_DIR + "/" + OLD_STORE_NAME
# Every spelling of that directory a shipped line may still carry: the contiguous glob, and the same
# directory built out of separate path elements (`"plugin-data"` then `"resetwatch"`), which a substring
# comparison cannot see.
LEGACY_SPELLINGS = re.compile(STORE_DIR + r"""["'/ ]{0,6}""" + OLD_STORE_NAME)
# usage_store.py's reader glob, plus the nine fixture paths in the suite that write a pre-rename store so
# the import stays tested. Locked rather than counted: an increase is something new learning the old name,
# a deletion is a test that stopped covering the history the reader glob exists to import.
LEGACY_SPELLING_COUNT = 10


def _tracked_text():
    for f in ROOT.rglob("*"):
        if not f.is_file() or f.suffix not in (".py", ".js", ".mjs", ".json", ".yaml", ".md"):
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


def test_the_old_store_dir_is_named_exactly_where_the_history_needs_it():
    """Every spelling of the old store directory is counted, and the number is a lock.

    The test this replaces looked for the contiguous glob only, so it reported "exactly one line" while
    nine more shipped lines named the same directory as separate path elements -- the old name is in the
    tree ten times, and the name of this test is what that number actually guards.
    """
    hits = [(f.relative_to(ROOT).as_posix(), i + 1) for f, text in _tracked_text()
            for i, line in enumerate(text.splitlines()) if LEGACY_SPELLINGS.search(line)]
    assert len(hits) == LEGACY_SPELLING_COUNT, hits
    assert {rel for rel, _ in hits} == {"usage_store.py", "tests/test_usage_page.py"}, hits
    # The one non-test spelling is the reader glob, and it is the line the gate above exempts.
    reader = [ln for ln in (ROOT / "usage_store.py").read_text(encoding="utf-8").splitlines()
              if LEGACY_SPELLINGS.search(ln)]
    assert len(reader) == 1, reader
    assert LEGACY_STORE in reader[0] and LEGACY_OK in reader[0], reader


def test_identity_is_one_string_across_surfaces():
    """One id on every surface that addresses the plugin with it -- the agent side included.

    `__init__.py` broadcasts each call row under its own copy of the id, so a drift there is invisible to
    the page (it keeps rendering) and to the manifest check (it keeps passing): the events simply go to a
    plugin id nobody is listening under.
    """
    manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    js = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    dash = (ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8")
    init = (ROOT / "__init__.py").read_text(encoding="utf-8")
    name = re.search(r'"name":\s*"([^"]+)"', manifest).group(1)
    pid = re.search(r"const PLUGIN_ID = '([^']+)'", js).group(1)
    dname = re.search(r'"name":\s*"([^"]+)"', dash).group(1)
    iid = re.search(r'^PLUGIN_ID = "([^"]+)"', init, re.M).group(1)
    assert name == pid == dname == iid == "hermes-call-ledger", (name, pid, dname, iid)


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
