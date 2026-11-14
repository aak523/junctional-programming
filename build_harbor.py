"""Generate the Harbor task folder from the experiment sources (one source of truth).

usage: python build_harbor.py [--seed N] [--out harbor/gpu-world]
The seed and verifier token only appear in the sidecar's compose environment and in tests/,
neither of which the agent can see while it plays.
"""
import argparse
import secrets
import shutil
from pathlib import Path

HERE = Path(__file__).parent
SIM = ["world.py", "lp.py", "policies.py", "service.py"]
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
can change silently. Rules and priors are fully documented; only realised values are hidden. Reward 0 = do-nothing,
1 = a perfect-information LP oracle; a Bayesian LP reference that sees exactly what the agent sees scores about 0.9."""

[verifier]
timeout_sec = 600.0
environment_mode = "shared"

[agent]
timeout_sec = 5400.0
network_mode = "allowlist"
allowed_hosts = []

[environment]
build_timeout_sec = 1200
cpus = 2
memory_mb = 4096
'''

OPENCODE = "1.19.5"

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
    environment:
      WORLD_SEED: "{seed}"
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
'''

SOLVE_SH = '''#!/bin/bash
set -e
cd /solution
python3 solve.py
'''

SOLVE_PY = '''"""Reference solution: the Bayesian LP reference policy, playing through the same server API as the agent."""
import json
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
while True:
    obs = json.loads(urllib.request.urlopen(URL + "/observe", timeout=60).read().decode())
    if obs["prices"]:   # JSON turned integer dict keys into strings
        obs["prices"]["reserve"] = {int(k): v for k, v in obs["prices"]["reserve"].items()}
    obs["met"] = {int(k): v for k, v in obs["met"].items()}
    if obs["month"] >= W.T:
        break
    pol(obs, act)
    print(act("end_month").splitlines()[0])
'''


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:   # LF even on Windows: these run in Linux containers
        f.write(text)


def instruction():
    t = (HERE / "TASK.md").read_text(encoding="utf-8")
    t = t.replace('You act only through `python gpu.py "<command>; <command>; ..."` (run `python gpu.py help`).',
                  'You act only through the `gpu` command: `gpu "<command>; <command>; ..."` (run `gpu help`). The world runs on a\n'
                  'separate server; there are no game files on this machine. You may write your own notes or scripts here.')
    assert "`gpu help`" in t, "TASK.md intro changed; update build_harbor.instruction()"
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261114)
    ap.add_argument("--name", default="gpu-world")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = Path(a.out) if a.out else HERE / "harbor" / a.name
    if out.exists():
        shutil.rmtree(out)
    token = secrets.token_hex(24)
    (out / "environment" / "world").mkdir(parents=True)
    (out / "tests").mkdir()
    (out / "solution").mkdir()
    write(out / "task.toml", TASK_TOML.format(name=a.name))
    write(out / "instruction.md", instruction())
    write(out / "environment" / "Dockerfile", MAIN_DOCKERFILE)
    write(out / "environment" / "gpu", GPU_CLIENT)
    write(out / "environment" / "docker-compose.yaml", COMPOSE.format(seed=a.seed, token=token))
    write(out / "environment" / "world" / "Dockerfile", WORLD_DOCKERFILE)
    for f in SIM + ["server.py"]:
        shutil.copy(HERE / f, out / "environment" / "world" / f)
    for f in SIM:
        shutil.copy(HERE / f, out / "solution" / f)
    write(out / "solution" / "solve.sh", SOLVE_SH)
    write(out / "solution" / "solve.py", SOLVE_PY)
    write(out / "tests" / "test.sh", TEST_SH)
    write(out / "tests" / "verify.py", VERIFY_PY.format(token=token))
    print(f"wrote {out} (seed {a.seed})")


if __name__ == "__main__":
    main()
