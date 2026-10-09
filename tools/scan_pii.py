"""PII gate: the shipped tree must not name one person's machine, profile or private tooling.

Same contract as the secret gate -- report ``rel:line``, never the matched line, exit 1 on any hit -- and
it walks the same file set, so the two scopes cannot drift apart.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from tools.scan_secrets import text_files                                   # noqa: E402

# The first letter of each private token sits in a character class: this table has to quote what it
# forbids, and a pattern that matched its own source would report the gate itself as a leak.
FORBIDDEN = {
    "profile name": r"neo_[a]gent|vex_[a]gent",
    "machine path": r"[H]a Trung|AppData\\Local|C:\\[U]sers",
    "private tooling": r"scratc[h]/|[b]ackups/|rollup-[p]re|usage-[p]rework",
    "peer host": r"[s]kappa|ts\.net|[d]unker-saturation",
}
COMPILED = {name: re.compile(pattern) for name, pattern in FORBIDDEN.items()}


def scan(root):
    """Lines naming something that belongs to one person's install. Returns "<rel>:<line>" only."""
    hits = []
    for rel, lines in text_files(root):
        for i, line in enumerate(lines, 1):
            if any(p.search(line) for p in COMPILED.values()):
                hits.append("%s:%d" % (rel, i))
    return hits


def main(argv):
    root = pathlib.Path(argv[1]) if len(argv) > 1 else pathlib.Path(__file__).resolve().parent.parent
    hits = scan(root)
    print("pii gate: %d hit(s) [%d pattern group(s)]" % (len(hits), len(FORBIDDEN)))
    for h in hits[:20]:
        print("  ", h)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
