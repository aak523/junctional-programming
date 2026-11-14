"""Parser and wrapper checks for llm_env. usage: python train/test_env.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402


def check_parse():
    segs, info = E.parse("```\nnote hi; set_spot 1 us; end_month; buy_gpus 3 H us\n```")
    assert segs == ["note hi", "set_spot 1 us"] and not info["forced_end"] and info["dropped_after_end"] == 1, (segs, info)
    segs, info = E.parse("note x\nreserve 1 12 us\nstatus; calc 1+1")
    assert segs == ["note x", "reserve 1 12 us"] and info["forced_end"] and info["ignored_free"] == 2, (segs, info)
    segs, info = E.parse("; ; ")
    assert segs == [] and info["forced_end"]
    segs, info = E.parse("; ".join(["set_spot 1 us"] * 30))
    assert len(segs) == E.MAX_SEGMENTS and info["truncated"] == 5


def check_episode():
    ep = E.Episode(12345)
    assert ep.messages()[0]["content"] == E.SYSTEM and "Month 0" in ep.user()
    # a ';' inside the note splits it: the tail becomes an unknown command (an ERROR, as in Harbor)
    out = ep.step("note a; b; set_spot 1.5 us; buy_gpus 2 H vendor us; end_month; reserve 1 12 us")
    assert out["executed"] == ["set_spot 1.5 us", "buy_gpus 2 H vendor us"], out
    assert out["errors"] == 1 and not out["forced_end"] and ep.month == 1, out
    out = ep.step("garbage words here")
    assert out["executed"] == [] and out["errors"] == 1 and out["forced_end"] and ep.month == 2, out
    out = ep.step("")
    assert out["executed"] == [] and out["errors"] == 0 and ep.month == 3
    assert "m0: a" in ep.user() and ep.user().count("\n 2 |") == 1, ep.user()[-800:]
    while not ep.done:
        ep.step("end_month")
    r = ep.result()
    assert r["errors"] == 2 and r["forced_ends"] == 2 and r["n_actions"] == 2, r


if __name__ == "__main__":
    check_parse()
    check_episode()
    print("llm_env checks passed; system prompt", len(E.SYSTEM), "chars, sha", E.SYSTEM_SHA)
