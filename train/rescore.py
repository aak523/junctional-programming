"""Re-score results with the current checkout's reward (world.score) and, unless --keep-oracle, its oracle. The world
(and so every recorded net cost) is unchanged; the oracle improved in 466fcc7 and the reward formula changed in b954cad.

usage: python train/rescore.py [--keep-oracle] base sft dagger ...   (rewrites train/results/<name>.json in place)
"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import llm_env as E  # noqa: E402
from eval_llm import summarise, world_commit  # noqa: E402
from gen_sft import oracle_cost  # noqa: E402


def main():
    keep = "--keep-oracle" in sys.argv
    names = [n for n in sys.argv[1:] if n != "--keep-oracle"]
    res = {n: json.loads((HERE / "results" / f"{n}.json").read_text()) for n in names}
    seeds = sorted({int(s) for r in res.values() for s in r["per_seed"]})
    if keep:   # the stored oracle costs are already this checkout's oracle
        oracle = {int(s): v["oracle_cost"] for r in res.values() for s, v in r["per_seed"].items()}
    else:
        with ProcessPoolExecutor(20) as ex:
            oracle = dict(zip(seeds, ex.map(oracle_cost, seeds)))
    commit = world_commit()
    for n, r in res.items():
        per = {int(s): v for s, v in r["per_seed"].items()}
        for s, v in per.items():
            v["oracle_cost"] = oracle[s]
            v["reward"] = round(E.score(v["net_cost"], oracle[s], v["milestones_met"]), 4)
        sets = [tuple(map(int, k.split("-"))) for k in r["sets"]]
        r.update(per_seed=per, sets=summarise(per, [(a, b + 1) for a, b in sets]),
                 **({} if keep else {"oracle_commit": commit}), reward_commit=commit)
        (HERE / "results" / f"{n}.json").write_text(json.dumps(r, indent=1))
        print(n, {k: v["mean_reward"] for k, v in r["sets"].items()})


if __name__ == "__main__":
    main()
