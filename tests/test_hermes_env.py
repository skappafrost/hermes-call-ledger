import pytest
import hermes_env


def test_env_var_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_AGENT_DIR", str(tmp_path))
    assert hermes_env.agent_dir() == tmp_path


def test_default_candidates_are_checked_in_order(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_AGENT_DIR", raising=False)
    monkeypatch.setattr(hermes_env, "CANDIDATES", lambda: [tmp_path / "nope", tmp_path / "hermes-agent"])
    (tmp_path / "hermes-agent").mkdir()
    (tmp_path / "hermes-agent" / "hermes_constants.py").write_text("", encoding="utf-8")
    assert hermes_env.agent_dir() == tmp_path / "hermes-agent"


def test_missing_checkout_says_how_to_fix_it(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_AGENT_DIR", raising=False)
    monkeypatch.setattr(hermes_env, "CANDIDATES", lambda: [tmp_path / "ghost"])
    with pytest.raises(RuntimeError) as exc:
        hermes_env.agent_dir()
    assert "HERMES_AGENT_DIR" in str(exc.value)
