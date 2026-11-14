"""Run agent attempts on the evaluation seeds in parallel, then tabulate them against the ladder.

usage: python run_all.py <seeds, e.g. 0,1,2> <attempts> [model]
       python run_all.py summary      (only re-tabulate existing runs/*/result.json)
"""
import json
import statistics
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import policies  # noqa: E402


def run(job):
    seed, attempt, model = job
    p = subprocess.run([sys.executable, str(HERE / "run_agent.py"), str(seed), str(attempt), model], capture_output=True, text=True)
    print((p.stdout.strip().splitlines() or [p.stderr[-300:]])[-1][:300], flush=True)


def summary():
    runs = [json.loads(f.read_text()) for f in sorted(HERE.glob("runs/*/result.json"))]
    seeds = sorted({r["seed"] for r in runs})
    lad = {s: policies.ladder(s) for s in seeds}
    names = ["do_nothing", "stop_early", "spot_only", "exploiter", "reference", "clairvoyant"]
    lines = ["| seed | " + " | ".join(names) + " | agent runs |", "|" + "---|" * (len(names) + 2)]
    for s in seeds:
        ag = [r for r in runs if r["seed"] == s]
        lines.append(f"| {s} | " + " | ".join(f"{lad[s][n]['net_cost']:.0f} ({lad[s][n]['milestones_met']}/3)" for n in names) + " | " +
                     ", ".join(f"{r['net_cost']:.0f} ({r['milestones_met']}/3, {r['months_played']} mo)" for r in ag) + " |")
    ref = {s: lad[s]["reference"]["net_cost"] for s in seeds}
    beat = sum(r["net_cost"] > ref[r["seed"]] for r in runs)
    lines.append(f"\nReference beats the agent in {beat}/{len(runs)} runs. Mean agent excess over reference: "
                 f"{statistics.mean(r['net_cost'] - ref[r['seed']] for r in runs):.0f} $M." if runs else "")
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
