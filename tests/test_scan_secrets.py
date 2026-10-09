import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import tools.scan_secrets as sc                                            # noqa: E402


def test_finds_a_planted_secret_and_never_echoes_it(tmp_path):
    (tmp_path / "a.py").write_text('PAT = "vituperate-abcdef0123456789"\n', encoding="utf-8")
    hits = sc.scan(tmp_path, ["vituperate-abcdef0123456789"])
    assert hits == ["a.py:1"], hits
    assert all("vituperate" not in h for h in hits)


def test_flags_token_shaped_strings(tmp_path):
    """Every shape the gate hunts, planted one at a time.

    The prefixes are assembled from pieces on purpose -- the gate walks this file too, and a contiguous
    credential prefix written anywhere in the tree would be a hit for its own repo-wide run. The values
    are fakes either way, and the gate reports `rel:line` so even a real one would not be echoed.
    """
    shapes = ["github_" "pat_" + "11ABCDEFGH0123456789abcdef",      # fine-grained PAT
              "gh" "p_" + "10ABCDEFGH0123456789abcdef",             # classic token
              "s" "k-" + "abcdefghij" + "klmnopqrst" + "uvwxyz"]    # vendor API key
    for i, fake in enumerate(shapes):
        (tmp_path / ("f%d.js" % i)).write_text('const k = "%s"\n' % fake, encoding="utf-8")
    hits = sc.scan(tmp_path, [])
    assert hits == ["f0.js:1", "f1.js:1", "f2.js:1"], hits
    assert all("ABCDEFGH" not in h and "abcdefghij" not in h for h in hits), hits
