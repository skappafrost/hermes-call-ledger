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
# The upstream plugin's catalog id, assembled from pieces so this file is not a hit for it either.
UPSTREAM_ID = "hermes-reset" "watch"
# Lineage and coexistence are README copy: the catalog's admission rule wants the upstream project named,
# and a reader choosing between two plugins that register the same three hooks needs the id in order to
# remove one. That is prose *about* a third party, which is not what this gate hunts -- it exists to catch
# this plugin still addressing itself by the old name (id, route, store dir), and those stay forbidden
# everywhere, README included: only this one token, in this one file, is exempted, and the number of
# exempted lines is locked below so a mention cannot spread unnoticed.
DOC_LINEAGE_FILE = "README.md"
DOC_LINEAGE_TOKENS = (UPSTREAM_ID,)
DOC_LINEAGE_LINES = 5
# The two spellings a shipped file uses to declare its version: the manifest/manifest-like `version`
# field, and the JS constant the page prints in its footer. The second is assembled out of pieces for the
# same reason the forbidden tokens are -- spelled as one literal anywhere in this file, including in this
# comment, it is itself a declaration of a version, and the gate below would report this file as a fifth
# shipped surface that makes the claim.
VERSION_FIELDS = (r'"version":\s*"([^"]+)"',
                  r"const VERSION = " r"'([^']+)'")
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

    The second, narrower exemption is the README's lineage prose: only the upstream catalog id, only in
    that file, only the locked number of lines. An old route or the old store directory in the README is
    still a failure, not an exemption.
    """
    exempt, lineage, bad = [], [], []
    for f, text in _tracked_text():
        rel = f.relative_to(ROOT).as_posix()
        for i, line in enumerate(text.splitlines()):
            found = [b for b in FORBIDDEN if b in line]
            if not found:
                continue
            where = (rel, i + 1)
            if rel == DOC_LINEAGE_FILE and all(b in DOC_LINEAGE_TOKENS for b in found):
                lineage.append(where)
            elif LEGACY_STORE in line and LEGACY_OK in line:
                exempt.append(where)
            else:
                bad.append(where)
    assert bad == [], bad
    assert len(exempt) == 1, exempt
    assert exempt[0][0] == "usage_store.py", exempt
    assert len(lineage) == DOC_LINEAGE_LINES, lineage
    assert {rel for rel, _ in lineage} == {DOC_LINEAGE_FILE}, lineage


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
    plugin id nobody is listening under. `dashboard/plugin_api.py` carries a fifth copy, because reading
    `plugins.entries.<id>.settings` needs the id and the dashboard module has no package to import it
    from -- a drift there answers the page with the defaults forever, which looks like an unset setting.
    """
    manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    js = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    dash = (ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8")
    init = (ROOT / "__init__.py").read_text(encoding="utf-8")
    api = (ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    name = re.search(r'"name":\s*"([^"]+)"', manifest).group(1)
    pid = re.search(r"const PLUGIN_ID = '([^']+)'", js).group(1)
    dname = re.search(r'"name":\s*"([^"]+)"', dash).group(1)
    iid = re.search(r'^PLUGIN_ID = "([^"]+)"', init, re.M).group(1)
    aid = re.search(r'^PLUGIN_ID = "([^"]+)"', api, re.M).group(1)
    assert name == pid == dname == iid == aid == "hermes-call-ledger", (name, pid, dname, iid, aid)


def test_store_is_under_the_plugin_id_dir():
    src = (ROOT / "usage_store.py").read_text(encoding="utf-8")
    assert '"plugin-data", "call-ledger", "calls.sqlite"' in src
    assert 'profiles/*/plugin-data/call-ledger/calls.sqlite' in src


# The manifest speaks for whoever publishes the repository. Written in two literals so this file -- the
# gate that forbids naming third parties -- does not carry the handle either: `plugin.yaml`'s `author`
# field stays the one place the published tree names a person.
MAINTAINER = "sk" "appafrost"


def test_every_declared_version_is_the_released_one():
    """Catalog rule 14: the version a plugin declares has to be the version its pinned code answers with.

    Three shipped files state it and the CHANGELOG states it again for readers: `plugin.yaml` is what
    `hermes plugins` prints and what the catalog entry pins, `dashboard/manifest.json` is the dashboard's
    copy of the same claim, the page prints its own constant in the footer, and the changelog's top
    section is the release record. Four places carrying three numbers is invisible to every other gate
    here and fatal to the docs card, which quotes the pin as fact.
    """
    declared = [(f.relative_to(ROOT).as_posix(), i + 1, value)
                for f, text in _tracked_text()
                for i, line in enumerate(text.splitlines())
                for pat in VERSION_FIELDS for value in re.findall(pat, line)]
    assert len(declared) >= 3, declared
    top = re.search(r"^## (\d+\.\d+\.\d+)", (ROOT / "CHANGELOG.md").read_text(encoding="utf-8"),
                    re.M).group(1)
    wrong = [d for d in declared if d[2] != top]
    assert wrong == [], "declared versions that are not %s: %r" % (top, wrong)
    # The three fields are the load-bearing ones; a fourth file learning to declare a version is a
    # decision, not an accident, so the set is named rather than counted.
    assert {rel for rel, _, _ in declared} == {"plugin.yaml", "dashboard/manifest.json",
                                              "desktop/plugin.js", "tests/page-under-test.mjs"}, declared


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
