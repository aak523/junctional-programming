"""Generate the Harbor task folder from the experiment sources (one source of truth).

usage: python scripts/build_harbor.py [--seed N] [--out harbor/gpu-world]
By default the sidecar draws a random world per trial. The verifier token only appears in the sidecar's
compose environment and in tests/, neither of which the agent can see while it plays.
"""
import argparse
import re
import secrets
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "gpu_world"
SIM = ["world.py", "lp.py", "policies.py", "service.py"]
SERVER = ["server.py", "compare.py"]   # the sidecar also runs the verifier's settlement and mistake report
PINS = "numpy==2.1.3 scipy==1.14.1"

TASK_TOML = '''schema_version = "1.4"

[task]
name = "junctional/{name}"
description = "Run compute procurement for an AI lab for 24 months under hidden, drifting supply conditions."
keywords = ["planning", "supply-chain", "partial-observability", "long-horizon"]

[metadata]
category = "planning"
difficulty_explanation = """The agent must hit three training-run windows and serve growing inference demand at the lowest settled
net cost while the supply regime, next-gen launch, export controls, inference growth and broker reliability are hidden and
can change silently. Rules and priors are fully documented; only realised values are hidden. Reward = the perfect-information
oracle's net cost / the agent's (capped at 1) times the share of training runs met, so doing nothing scores 0; a Bayesian
LP reference that sees exactly what the agent sees scores about 0.9."""

[verifier]
timeout_sec = 600.0
environment_mode = "shared"

# The agent keeps public network access: Harbor's egress allowlist broke DNS for the model endpoint on Docker Desktop.
# Nothing useful is reachable: the world runs in the sidecar, which draws a random 48-bit seed at startup, so even
# with world.py from a public repo the hidden future cannot be reconstructed.
[agent]
timeout_sec = {timeout}

[environment]
build_timeout_sec = 1200
cpus = 2
memory_mb = 4096
'''

OPENCODE = "1.19.5"
AGENT_MINUTES = 30   # judges run reference + 3 agent runs (in parallel) + baselines; the reference plays in about 70 s; Gemini 4 Carbon needs ~90 s/step

# OpenCode is baked in: Harbor skips its own install when `opencode --version` works, and installing Node and
# OpenCode at agent setup can exceed Harbor's 360 s setup timeout.
MAIN_DOCKERFILE = f'''FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl bash nodejs npm ca-certificates \\
    && rm -rf /var/lib/apt/lists/* \\
    && npm i -g opencode-ai@{OPENCODE} && opencode --version
RUN pip install --no-cache-dir {PINS}
COPY gpu /usr/local/bin/gpu
RUN chmod 755 /usr/local/bin/gpu
WORKDIR /app
'''

WORLD_DOCKERFILE = f'''FROM python:3.12-slim
RUN pip install --no-cache-dir {PINS}
WORKDIR /srv
COPY *.py /srv/
CMD ["python", "server.py"]
'''

COMPOSE = '''services:
  main:
    depends_on:
      world:
        condition: service_healthy

  world:
    build:
      context: ./world
    environment:{seed_line}
      VERIFY_TOKEN: "{token}"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=2)"]
      interval: 2s
      timeout: 5s
      retries: 30
      start_period: 5s
'''

# The server is the `world` compose service. Under Harbor's egress control the services share one network
# namespace (so it is on localhost); otherwise it is reached by service name.
FIND_SERVER = '''def server():
    for url in ("http://localhost:8000", "http://world:8000"):
        try:
            urllib.request.urlopen(url + "/health", timeout=3)
            return url
        except OSError:
            pass
    raise SystemExit("GPU World server unreachable")
'''

GPU_CLIENT = '''#!/usr/bin/env python3
"""gpu "<command>; <command>; ..."  -- talk to the GPU World server (run `gpu help`)."""
import sys
import urllib.request

''' + FIND_SERVER + '''

line = " ".join(sys.argv[1:]) or "status"
req = urllib.request.Request(server() + "/cmd", data=line.encode(), method="POST")
print(urllib.request.urlopen(req, timeout=300).read().decode())
'''

TEST_SH = '''#!/bin/bash
mkdir -p /logs/verifier
python3 /tests/verify.py || echo 0 > /logs/verifier/reward.txt
'''

VERIFY_PY = '''"""Ask the world server to settle the episode; write the 0..1 reward and the details."""
import json
import urllib.request

''' + FIND_SERVER.replace("{", "{{").replace("}", "}}") + '''

req = urllib.request.Request(server() + "/settle", data=json.dumps({{"token": "{token}"}}).encode(), method="POST")
res = json.loads(urllib.request.urlopen(req, timeout=500).read().decode())
open("/logs/verifier/details.json", "w").write(json.dumps(res, indent=1))
open("/logs/verifier/reward.txt", "w").write(f"{{res['reward']:.4f}}\\n")
print(json.dumps({{k: res[k] for k in ("reward", "net_cost", "months_played", "milestones_met", "scale")}}, indent=1))
print("Mistake report (the agent's game vs the reference's on this world):")
print("\\n".join("- " + x for x in res["diagnosis"]["findings"]))
'''

SOLVE_SH = '''#!/bin/bash
set -e
cd /solution
python3 solve.py
'''

SOLVE_PY = '''"""Reference solution: the Bayesian LP reference policy, playing through the same server API as the agent.
With STOP_AFTER=<months> (harbor run ... -a oracle --ae STOP_AFTER=3) it is the stop-early baseline: it plays the
first months, then stops, and the remaining months run with no actions."""
import json
import os
import urllib.request

import policies
import world as W

''' + FIND_SERVER + '''

URL = server()


def act(line):
    reply = urllib.request.urlopen(urllib.request.Request(URL + "/cmd", data=line.encode(), method="POST"), timeout=300).read().decode()
    if "ERROR:" in reply:
        raise ValueError(reply)
    return reply


pol = policies.LPPolicy()
stop = int(os.environ.get("STOP_AFTER") or W.T)
while True:
    obs = json.loads(urllib.request.urlopen(URL + "/observe", timeout=60).read().decode())
    if obs["prices"]:   # JSON turned integer dict keys into strings
        obs["prices"]["reserve"] = {int(k): v for k, v in obs["prices"]["reserve"].items()}
    obs["met"] = {int(k): v for k, v in obs["met"].items()}
    if obs["month"] >= min(W.T, stop):
        break
    pol(obs, act)
    print(act("end_month").splitlines()[0])
'''


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:   # LF even on Windows: these run in Linux containers
        f.write(text)


def instruction():
    t = (ROOT / "TASK.md").read_text(encoding="utf-8")
    t = t.replace('You act only through `python gpu.py "<command>; <command>; ..."` (run `python gpu.py help`).',
                  'You act only through the `gpu` command: `gpu "<command>; <command>; ..."` (run `gpu help`). The world runs on a\n'
                  'separate server; there are no game files on this machine. You may write your own notes or scripts here.')
    assert "`gpu help`" in t, "TASK.md intro changed; update build_harbor.instruction()"
    t = t.replace("Play all 24 months: if you stop early,",
                  f"**Time limit: {AGENT_MINUTES} minutes of wall-clock time for the whole game** (a full game takes about 25-30 tool\n"
                  "calls); budget any analysis accordingly. Play all 24 months: if you stop early or run out of time,")
    assert f"{AGENT_MINUTES} minutes" in t, "TASK.md 'Play all 24 months' sentence changed; update build_harbor.instruction()"
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=None, help="fix the world (default: a fresh random world per trial)")
    ap.add_argument("--name", default="gpu-world")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = Path(a.out) if a.out else ROOT / "harbor" / a.name
    # keep the verifier token stable across rebuilds: trials already running hold the old one
    old = out / "tests" / "verify.py"
    m = re.search(r'"token": "([0-9a-f]+)"', old.read_text()) if old.exists() else None
    token = m.group(1) if m else secrets.token_hex(24)
    # overwrite in place (never delete): a running Harbor job holds this folder open and uploads tests/ at the end
    for d in ("environment/world", "tests", "solution"):
        (out / d).mkdir(parents=True, exist_ok=True)
    write(out / "task.toml", TASK_TOML.format(name=a.name, timeout=f"{AGENT_MINUTES * 60:.1f}"))
    write(out / "instruction.md", instruction())
    write(out / "environment" / "Dockerfile", MAIN_DOCKERFILE)
    write(out / "environment" / "gpu", GPU_CLIENT)
    # a fixed seed is public (it is in this repo): JUDGE_KEY from the shell running harbor makes it private
    seed_line = "" if a.seed is None else f'\n      WORLD_SEED: "{a.seed}"\n      JUDGE_KEY: "${{JUDGE_KEY:-}}"'
    write(out / "environment" / "docker-compose.yaml", COMPOSE.format(seed_line=seed_line, token=token))
    write(out / "environment" / "world" / "Dockerfile", WORLD_DOCKERFILE)
    for f in SIM + SERVER:
        shutil.copy(SRC / f, out / "environment" / "world" / f)
    for f in SIM:
        shutil.copy(SRC / f, out / "solution" / f)
    write(out / "solution" / "solve.sh", SOLVE_SH)
    write(out / "solution" / "solve.py", SOLVE_PY)
    write(out / "tests" / "test.sh", TEST_SH)
    write(out / "tests" / "verify.py", VERIFY_PY.format(token=token))
    print(f"wrote {out} ({'random world per trial' if a.seed is None else f'fixed seed {a.seed}'})")


if __name__ == "__main__":
    main()
