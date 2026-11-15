"""Evaluate a model (greedy) or a scripted policy on held-out seed sets.

usage: python train/eval_llm.py --model scripted:reference --seeds 0 10 --seeds 20000 20020 --name reference
       python train/eval_llm.py --model train/ckpt/sft-merged --seeds 0 10 --seeds 20000 20020 --name sft
Writes train/results/<name>.json (per seed and per set) and, for models, train/data/eval_<name>.jsonl.
"""
import argparse
import json
import statistics
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import llm_env as E  # noqa: E402
import policies  # noqa: E402
from gen_sft import oracle_cost  # noqa: E402

SCRIPTED = ("do_nothing", "reference", "oracle")


def scripted_seed(args):
    name, seed = args
    pol, stop = policies.LADDER[name]
    s = policies.play(pol, seed, stop)
    oracle = s["net_cost"] if name == "oracle" else oracle_cost(seed)
    return {"net_cost": s["net_cost"], "oracle_cost": oracle, "reward": round(E.score(s["net_cost"], oracle), 4),
            "milestones_met": s["milestones_met"], "errors": 0, "forced_ends": 0, "n_actions": None}


def world_commit():
    root = HERE.parent
    h = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--", "world.py", "lp.py", "policies.py", "TASK.md"],
                           cwd=root, capture_output=True, text=True).stdout.strip()
    return h + ("+dirty" if dirty else "")


def summarise(per_seed, sets):
    out = {}
    for a, b in sets:
        rows = [per_seed[s] for s in range(a, b)]
        acts = [r["n_actions"] for r in rows if r["n_actions"] is not None]
        errs = sum(r["errors"] for r in rows)
        out[f"{a}-{b - 1}"] = {"n": len(rows), "mean_reward": round(statistics.mean(r["reward"] for r in rows), 4),
                               "mean_net_cost": round(statistics.mean(r["net_cost"] for r in rows), 2),
                               "all_milestones": sum(r["milestones_met"] == 3 for r in rows),
                               "error_rate": round(errs / (errs + sum(acts)), 4) if acts and errs + sum(acts) else 0.0,
                               "forced_ends": sum(r["forced_ends"] for r in rows)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="scripted:<do_nothing|reference|oracle> or a model path / HF id")
    ap.add_argument("--seeds", type=int, nargs=2, action="append", required=True, metavar=("FIRST", "END"))
    ap.add_argument("--name", required=True)
    ap.add_argument("--procs", type=int, default=6)
    a = ap.parse_args()
    seeds = [s for x, y in a.seeds for s in range(x, y)]
    if a.model.startswith("scripted:"):
        name = a.model.split(":", 1)[1]
        assert name in SCRIPTED, name
        with ProcessPoolExecutor(a.procs) as ex:
            per_seed = dict(zip(seeds, ex.map(scripted_seed, [(name, s) for s in seeds])))
    else:
        import rollout
        recs = rollout.play(rollout.load_llm(a.model), seeds, 1, 0.0, a.name, procs=a.procs)
        rollout.write(recs, HERE / "data" / f"eval_{a.name}.jsonl")
        per_seed = {}
        for r in recs:
            if r["month"] == 0:
                e = r["episode"]
                per_seed[r["seed"]] = {**{k: e[k] for k in ("net_cost", "oracle_cost", "reward", "milestones_met", "errors", "forced_ends")},
                                       "n_actions": sum(len(x["executed"]) for x in recs if x["seed"] == r["seed"])}
    res = {"name": a.name, "model": a.model, "world_commit": world_commit(), "system_sha": E.SYSTEM_SHA, "prompt": E.PROMPT,
           "sets": summarise(per_seed, a.seeds), "per_seed": per_seed}
    out = HERE / "results" / f"{a.name}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(res, indent=1))
    print(json.dumps(res["sets"], indent=1))


if __name__ == "__main__":
    main()
