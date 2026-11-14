"""Teacher data: the Bayesian-LP reference plays training seeds; one JSONL record per month.

usage: python train/gen_sft.py --seeds 10000 10400 --procs 6 --out train/data/sft_ref.jsonl
       python train/gen_sft.py --verify train/data/sft_ref.jsonl [--against-play 2]
"""
import argparse
import json
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402
import policies  # noqa: E402


def oracle_cost(seed):
    return policies.play(policies.OracleMPC, seed)["net_cost"]


def episode_fields(res, oracle):
    return {"net_cost": res["net_cost"], "oracle_cost": oracle, "reward": round(E.score(res["net_cost"], oracle), 4),
            "milestones_met": res["milestones_met"], "errors": res["errors"], "forced_ends": res["forced_ends"]}


def teacher_episode(seed):
    ep = E.Episode(seed)
    pol = policies.LPPolicy()
    recs = []
    while not ep.done:
        user = ep.user()
        obs = ep.observe()
        cmds = []

        def act(c):
            r = ep.act_direct(c)
            cmds.append(c)
            return r
        pol(obs, act)
        note = E.synth_note(pol.bel, obs, cmds)
        ep.note(note)
        recs.append({"seed": seed, "policy": "reference", "sample": 0, "month": obs["month"], "system_sha": E.SYSTEM_SHA,
                     "user": user, "completion": E.completion_of(note, cmds), "executed": cmds, "errors": 0,
                     "forced_end": False})
        ep.close_month()
    ep_fields = episode_fields(ep.result(), oracle_cost(seed))
    for r in recs:
        r["episode"] = ep_fields
    return recs


def load(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def episodes(recs):
    by = defaultdict(list)
    for r in recs:
        by[r["seed"], r["sample"]].append(r)
    return {k: sorted(v, key=lambda r: r["month"]) for k, v in by.items()}


def verify(path, against_play):
    eps = episodes(load(path))
    for i, ((seed, sample), recs) in enumerate(sorted(eps.items())):
        assert len(recs) == 24 and all(r["system_sha"] == E.SYSTEM_SHA for r in recs), (seed, "incomplete or stale prompt")
        ep = E.Episode(seed)
        for r in recs:
            assert ep.user() == r["user"], (seed, r["month"], "prompt differs on replay")
            assert seed < 1000 or str(seed) not in r["user"], (seed, "seed leaked into the prompt")
            out = ep.step(r["completion"])
            assert out["errors"] == 0 and not out["forced_end"], (seed, r["month"], out["reply"][-300:])
            assert out["executed"] == r["executed"], (seed, r["month"], out["executed"], r["executed"])
        net = ep.result()["net_cost"]
        assert net == r["episode"]["net_cost"], (seed, net, r["episode"]["net_cost"])
        if i < against_play:
            ref = policies.play(policies.LPPolicy, seed)["net_cost"]
            assert net == ref, (seed, net, ref, "wrapper is not lossless against policies.play")
            print(f"seed {seed}: replay {net} == policies.play {ref}")
    rewards = [v[0]["episode"]["reward"] for v in eps.values()]
    print(f"verified {len(eps)} episodes, {sum(map(len, eps.values()))} records; mean reward {sum(rewards) / len(rewards):.4f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, nargs=2, metavar=("FIRST", "END"))
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--out")
    ap.add_argument("--verify")
    ap.add_argument("--against-play", type=int, default=0, help="also compare the first N episodes with policies.play")
    a = ap.parse_args()
    if a.verify:
        return verify(a.verify, a.against_play)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with ProcessPoolExecutor(a.procs) as ex, open(a.out, "w", encoding="utf-8") as f:
        for recs in ex.map(teacher_episode, range(*a.seeds)):
            for r in recs:
                f.write(json.dumps(r) + "\n")
            f.flush()
            n += 1
            print(f"{n} episodes, seed {recs[0]['seed']}: reward {recs[0]['episode']['reward']}", flush=True)


if __name__ == "__main__":
    main()
