"""Put the repo root and tests/ on sys.path so tool modules and the harness helpers import from
anywhere. The suite has no package markers on purpose: tests/ without __init__.py is collected by
file name, and a copy of the repo in any directory keeps `py -3.13 -m pytest tests -q` and
`py -3.13 tests/test_usage_page.py` both working."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
for p in (str(ROOT), str(ROOT / "tests")):
    if p not in sys.path:
        sys.path.insert(0, p)
