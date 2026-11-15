#!/usr/bin/env bash
# The judges' evaluation in one command, on three fixed worlds (harbor/judge/gpu-world-{a,b,c}): the reference,
# one agent game per world (three in all), the do-nothing baseline and the stop-early baseline, then one table
# and the verifier's mistake report for each agent game.
#
# usage: ./judge.sh <provider/model> [extra harbor args for the agent run]
#   ./judge.sh gemini/gemini-4-hydrogen --api-key-name GEMINI_API_KEY --env-file .env
#   ./judge.sh anthropic/claude-opus-5-5                       # ANTHROPIC_API_KEY in the shell environment
#   JUDGE_KEY=<any private words> ./judge.sh <model> ...      # private worlds (recommended, see below)
# The worlds' seeds (4, 8, 9 from the evaluation range) are published in this repo, and the agent has internet
# access, so it could in principle look its world up. JUDGE_KEY turns each into a private seed; the same key gives
# the same worlds on every run. The reference is deterministic for a seed, so its rewards reproduce exactly: without
# a key they are the README's numbers.
set -uo pipefail   # no -e: one failed run should not hide the others in the table
[ -n "${JUDGE_KEY:-}" ] || echo "JUDGE_KEY not set: playing the published worlds (seeds 4, 8, 9)" >&2
export JUDGE_KEY="${JUDGE_KEY:-}"
MODEL=${1:?usage: ./judge.sh <provider/model> [extra harbor args for the agent run]}
shift
cd "$(dirname "$0")"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=jobs
run() { harbor run -p harbor/judge -o "$OUT" --job-name "judge-$STAMP-$1" -n 3 -y "${@:2}"; }

run reference  -a oracle
run do-nothing -a nop
run stop-early -a oracle --ae STOP_AFTER=3        # the reference for months 0..2, then no more actions
run agent      -a opencode -m "$MODEL" -k 1 "$@"

PY=$(command -v python3 || command -v python)
"$PY" - "$OUT" "$STAMP" <<'PYTHON'
import glob, json, sys
out, stamp = sys.argv[1:]
runs = ("reference", "agent", "do-nothing", "stop-early")
rows, why = {}, {}
for r in runs:
    for f in glob.glob(f"{out}/judge-{stamp}-{r}/*/verifier/reward.txt"):
        world = f.replace("\\", "/").split("/")[-3].split("__")[0]
        rows.setdefault(world, {})[r] = float(open(f).read())
        if r == "agent":
            try:
                why[world] = json.load(open(f.replace("reward.txt", "details.json")))["diagnosis"]["findings"]
            except (OSError, KeyError, ValueError):
                pass
print(f"\n{'world':12}" + "".join(f"{r:>12}" for r in runs) + f"{'agent/ref':>12}")
for w in sorted(rows):
    x = rows[w]
    ratio = f"{x['agent'] / x['reference']:.0%}" if "agent" in x and x.get("reference") else "-"
    print(f"{w:12}" + "".join(f"{x[r]:>12.4f}" if r in x else f"{'-':>12}" for r in runs) + f"{ratio:>12}")
for w, f in sorted(why.items()):
    print(f"\n{w}: the agent's game against the reference's on the same world")
    print("\n".join("  - " + x for x in f))
PYTHON
