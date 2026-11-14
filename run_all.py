"""Run agent attempts on evaluation seeds in parallel, then score them against the ladder.

usage: python run_all.py <seeds, e.g. 0,1,2> <attempts> [model]
       python run_all.py summary      (only re-score existing runs/*/result.json)

Score per run: (C_do_nothing - C) / (C_do_nothing - C_oracle), so do-nothing = 0 and the perfect-information
oracle = 1. Per seed (StoreBench-style reliability): 0.7 * mean + 0.3 * worst attempt.
"""
import json
import statistics
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import policies  # noqa: E402

COLS = ["do_nothing", "stop_early", "spot_only", "exploiter", "heuristic", "reference", "oracle", "lp_bound"]


def run(job):
    seed, attempt, model = job
    p = subprocess.run([sys.executable, str(HERE / "run_agent.py"), str(seed), str(attempt), model], capture_output=True, text=True)
    print((p.stdout.strip().splitlines() or [p.stderr[-300:]])[-1][:300], flush=True)


def ladder_for(seeds):
    path = HERE / "results" / "ladder.json"
    cache = {int(k): v for k, v in json.loads(path.read_text()).items()} if path.exists() else {}
    missing = [s for s in seeds if s not in cache or "oracle" not in cache[s]]
    with ProcessPoolExecutor(6) as ex:
        cache.update(zip(missing, ex.map(policies.ladder, missing)))
    path.write_text(json.dumps({str(k): v for k, v in sorted(cache.items())}, indent=1))
    return cache


def summary():
    runs = [json.loads(f.read_text()) for f in sorted(HERE.glob("runs/*/result.json"))]
    bad = [r["run"] for r in runs if r.get("harness_error")]
    runs = [r for r in runs if not r.get("harness_error")]
    seeds = sorted({r["seed"] for r in runs})
    lad = ladder_for(seeds)

    def score(s, c):
        return (lad[s]["do_nothing"]["net_cost"] - c) / (lad[s]["do_nothing"]["net_cost"] - lad[s]["oracle"]["net_cost"])

    lines = ["| seed | " + " | ".join(COLS) + " | agent runs | agent score (0.7 mean + 0.3 worst) | reference score |",
             "|" + "---|" * (len(COLS) + 4)]
    comp, refs = [], []
    for s in seeds:
        ag = [r for r in runs if r["seed"] == s]
        sc = [score(s, r["net_cost"]) for r in ag]
        c = 0.7 * statistics.mean(sc) + 0.3 * min(sc)
        comp.append(c)
        refs.append(score(s, lad[s]["reference"]["net_cost"]))
        cells = [f"{lad[s][n]['net_cost']:.0f}" + ("" if lad[s][n]["milestones_met"] is None else f" ({lad[s][n]['milestones_met']})") for n in COLS]
        lines.append(f"| {s} | " + " | ".join(cells) + " | " +
                     ", ".join(f"{r['net_cost']:.0f} ({r['milestones_met']})" for r in ag) + f" | {c:.2f} | {refs[-1]:.2f} |")
    if runs:
        beat = sum(r["net_cost"] > lad[r["seed"]]["reference"]["net_cost"] for r in runs)
        lines.append(f"\nRuns: {len(runs)} valid" + (f" ({len(bad)} excluded for harness errors: {', '.join(bad)})" if bad else "") +
                     f". Reference beats the agent in {beat}/{len(runs)} runs. Mean agent score {statistics.mean(comp):.2f} "
                     f"vs reference {statistics.mean(refs):.2f} (do-nothing 0, oracle 1). "
                     f"Belief notes per run: {[len(r.get('notes', [])) for r in runs]}.")
    out = "\n".join(lines)
    (HERE / "results" / "table.md").write_text(out + "\n")
    print(out)


if __name__ == "__main__":
    if sys.argv[1] != "summary":
        seeds = [int(x) for x in sys.argv[1].split(",")]
        model = sys.argv[3] if len(sys.argv) > 3 else "claude-opus-5-5"
        jobs = [(s, a, model) for s in seeds for a in range(1, int(sys.argv[2]) + 1)]
        with ThreadPoolExecutor(max_workers=3) as ex:
            list(ex.map(run, jobs))
    summary()
