import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import tools.scan_pii as sp                                       # noqa: E402

# Assembled rather than written out: the scanner walks this file too, and a gate that matched its own
# source could never report a clean tree. The values below are fakes either way.
PATH_TOKEN = "Ha " + "Trung"
PROFILE_TOKEN = "neo_" + "agent"


def test_flags_profile_names_and_machine_paths(tmp_path):
    (tmp_path / "a.py").write_text('HOME = "C:\\Users\\' + PATH_TOKEN + '\\x"\n'
                                   'P = "' + PROFILE_TOKEN + '"\n', encoding="utf-8")
    hits = sp.scan(tmp_path)
    assert len(hits) == 2, hits
    assert all(PATH_TOKEN not in h and PROFILE_TOKEN not in h for h in hits), hits
