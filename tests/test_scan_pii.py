import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import tools.scan_pii as sp                                       # noqa: E402

# Assembled rather than written out: the scanner walks this file too, and a gate that matched its own
# source could never report a clean tree. The values below are fakes either way.
PATH_TOKEN = "Ha " + "Trung"
PROFILE_TOKEN = "neo_" + "agent"
# The maintainer's own handle -- the manifest `author` field, which is public by definition -- and the
# private funnel host it must not be confused with. Both in pieces, for the reason above.
HANDLE_TOKEN = "sk" "appafrost"
HOST_TOKEN = "sk" "appa" + ".dun" "ker-satu" + "ration." + "ts" ".net"


def test_flags_profile_names_and_machine_paths(tmp_path):
    (tmp_path / "a.py").write_text('HOME = "C:\\Users\\' + PATH_TOKEN + '\\x"\n'
                                   'P = "' + PROFILE_TOKEN + '"\n', encoding="utf-8")
    hits = sp.scan(tmp_path)
    assert len(hits) == 2, hits
    assert all(PATH_TOKEN not in h and PROFILE_TOKEN not in h for h in hits), hits


def test_the_peer_host_is_a_hit_and_the_maintainer_handle_is_not(tmp_path):
    """Narrowing the host pattern must not open a hole in it.

    The host label and the publisher's handle share their first syllable, so the group has to tell them
    apart: name the host and this reports the line, carry the handle in the manifest and it must not.
    """
    (tmp_path / "h.py").write_text('H = "%s"\nA = "%s"\n' % (HOST_TOKEN, HANDLE_TOKEN), encoding="utf-8")
    hits = sp.scan(tmp_path)
    assert hits == ["h.py:1"], hits
