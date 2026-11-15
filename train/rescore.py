"""Re-score results against the oracle of the current checkout. The world (and so every recorded net cost) is
unchanged; only the reward denominator moved when the oracle improved.

usage: python train/rescore.py base sft dagger ...   (rewrites train/results/<name>.json in place)
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
    names = sys.argv[1:]
    res = {n: json.loads((HERE / "results" / f"{n}.json").read_text()) for n in names}
    seeds = sorted({int(s) for r in res.values() for s in r["per_seed"]})
    with ProcessPoolExecutor(20) as ex:
        oracle = dict(zip(seeds, ex.map(oracle_cost, seeds)))
    commit = world_commit()
    for n, r in res.items():
        per = {int(s): v for s, v in r["per_seed"].items()}
        for s, v in per.items():
            v["oracle_cost"] = oracle[s]
            v["reward"] = round(E.score(v["net_cost"], oracle[s]), 4)
        sets = [tuple(map(int, k.split("-"))) for k in r["sets"]]
        r.update(per_seed=per, sets=summarise(per, [(a, b + 1) for a, b in sets]), oracle_commit=commit)
        (HERE / "results" / f"{n}.json").write_text(json.dumps(r, indent=1))
        print(n, {k: v["mean_reward"] for k, v in r["sets"].items()})


if __name__ == "__main__":
    main()
