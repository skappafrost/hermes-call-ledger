"""Secret gate: no live credential may reach the tree, and this file never prints one.

Run it before every release: `py -3.13 tools/scan_secrets.py`. It reads the home's `.env` for VALUES
only, in order to check that none of them appear in this tree; it prints counts and `rel:line`, and it
never prints a line it matched, so the report itself cannot leak what it found.
"""
import os
import pathlib
import re
import sys

# The first letter of each shape sits in a character class, the way the PII gate quotes what it forbids:
# this file names the shapes it hunts, and a pattern that matched its own source would report the gate
# itself as a leak -- and put a credential prefix into the tree the gate is meant to keep clean.
SHAPED = re.compile(r"[g]ithub_pat_[A-Za-z0-9_]{20,}|[g]hp_[A-Za-z0-9]{20,}|"
                    r"[s]k-[A-Za-z0-9]{20,}|VILAO_PAT\s*=\s*\S{8,}")
SKIP_DIRS = {"__pycache__", ".git", "node_modules"}
# Only the local planning scaffolding is out of scope, and it is never tracked: every path a `git push`
# would publish is scanned. (This list used to exempt a `docs/` tree that was about to be published --
# see the A1 finding; the exemption is what let that through, so it does not come back.)
NOT_SHIPPED = {".superpowers"}
TEXT = {".py", ".js", ".mjs", ".json", ".yaml", ".yml", ".md", ".txt", ".env"}


def _shipped(rel: pathlib.PurePath) -> bool:
    posix = rel.as_posix()
    return not any(part in SKIP_DIRS for part in rel.parts) and not any(
        posix.startswith(p) for p in NOT_SHIPPED)


def text_files(root):
    """Yield ``(rel, lines)`` for every shipped text file -- the one walk every gate in this repo reads,
    so the scope cannot drift between them."""
    for f in sorted(pathlib.Path(root).rglob("*")):
        if not f.is_file() or f.suffix not in TEXT:
            continue
        rel = f.relative_to(root)
        if not _shipped(rel):
            continue
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        yield rel.as_posix(), lines


def scan(root, secrets):
    """Lines containing a known secret value or a token shape. Returns "<rel>:<line>" only."""
    hits = []
    for rel, lines in text_files(root):
        for i, line in enumerate(lines, 1):
            if SHAPED.search(line) or any(s and s in line for s in secrets):
                hits.append("%s:%d" % (rel, i))
    return hits


def live_values():
    """The home's `.env` secrets, read for VALUES ONLY and never printed or returned in full."""
    env = pathlib.Path(os.environ.get("HERMES_ENV_FILE")
                       or (pathlib.Path(os.environ.get("LOCALAPPDATA") or "") / "hermes" / ".env")
                       or (pathlib.Path.home() / ".hermes" / ".env"))
    out = []
    if env.is_file():
        text = env.read_text(encoding="utf-8", errors="replace")
        for name in ("VILAO_PAT", "GITHUB_TOKEN"):
            m = re.search(r"^%s=(.+)$" % name, text, re.M)
            if m:
                out.append(m.group(1).strip())
    return out


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    live = live_values()
    hits = scan(root, live)
    print("secret gate: %d hit(s) [live values checked: %d]" % (len(hits), len(live)))
    for h in hits[:20]:
        print("  ", h)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
