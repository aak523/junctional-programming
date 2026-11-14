"""Run one headless frontier-agent episode on a seed, then settle and score it server-side.

usage: python run_agent.py <seed> <attempt> [model] [max_turns]
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import service  # noqa: E402
import world as W  # noqa: E402

GPU_PY = "import subprocess, sys\nsys.exit(subprocess.call([sys.executable, r'{svc}', r'{state}', ' '.join(sys.argv[1:])]))\n"
PROMPT = ("Read TASK.md, then play all 24 months through `python gpu.py`. "
          "Batch each month's actions and end_month into one call where you can.")


def main(seed, attempt, model="claude-opus-5-5", max_turns=120):
    name = f"seed{seed}_{attempt}"
    run = HERE / "runs" / name
    if run.exists():
        shutil.rmtree(run)
    run.mkdir(parents=True)
    (HERE / "state").mkdir(exist_ok=True)
    state = (HERE / "state" / f"{name}.json").resolve()
    state.write_text(json.dumps({"seed": seed, "actions": []}))
    shutil.copy(HERE / "TASK.md", run / "TASK.md")
    (run / "gpu.py").write_text(GPU_PY.format(svc=(HERE / "service.py").resolve(), state=state))

    cmd = [shutil.which("claude"), "-p", PROMPT, "--model", model, "--output-format", "json",
           "--setting-sources", "local", "--strict-mcp-config", "--no-session-persistence",
           "--max-turns", str(max_turns), "--allowedTools", "Bash(python gpu.py:*)", "PowerShell(python gpu.py:*)",
           "--disallowedTools", "WebSearch", "WebFetch", "Task", "Agent", "Write", "Edit"]
    proc = subprocess.run(cmd, cwd=run, capture_output=True, text=True, encoding="utf-8")
    (run / "transcript.json").write_text(proc.stdout or proc.stderr, encoding="utf-8")

    meta, w = service.load(state)
    months_played = w.t
    s = w.finish()
    try:
        info = json.loads(proc.stdout)
        used = ",".join(info.get("modelUsage", {}).keys()) or model
        turns, usd = info.get("num_turns"), info.get("total_cost_usd")
    except Exception:
        used, turns, usd = model, None, None
    result = {"run": name, "seed": seed, "model": used, "months_played": months_played, "turns": turns, "usd": usd,
              "actions": meta["actions"], **s}
    (run / "result.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({k: v for k, v in result.items() if k != "actions"}))


if __name__ == "__main__":
    a = sys.argv[1:]
    main(int(a[0]), a[1], *(a[2:3] or []), *([int(a[3])] if len(a) > 3 else []))
