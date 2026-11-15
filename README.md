# GPU World

An RL environment for the AfterQuery "Break the Agent" track (Junction 2026). The agent is compute procurement lead at
an AI lab for 24 months across three sites (`us`, `eu`, `ap`). It must finish three training runs inside their windows
and serve each site's inference demand at the lowest net cost. To do that it buys GPUs directly from a vendor or two
third-party brokers, reserves cloud capacity, buys and exercises capacity options, rents spot, signs power, moves and
resells hardware, and manages cash on a credit line. The rules the agent reads are in [TASK.md](TASK.md).

The supply regime, the next GPU generation's launch month, export controls, inference growth and broker reliability are
hidden and can change without notice. Their structure and priors are all in TASK.md, so a careful agent can infer them.
The difficulty is in deciding under that uncertainty: when to commit capital, how much flexibility to pay for, and
when to explore an untested supplier.

## Run the evaluation

Requirements: bash, Docker, Python 3 and Harbor (`uv tool install harbor`).

```
JUDGE_KEY=<any private words> ./judge.sh gemini/gemini-4-hydrogen --api-key-name GEMINI_API_KEY --env-file .env
JUDGE_KEY=<any private words> ./judge.sh anthropic/<model>          # ANTHROPIC_API_KEY in the shell environment
```

`judge.sh` runs the standard harness (Harbor + OpenCode) on three fixed worlds, `harbor/judge/gpu-world-{a,b,c}`:
the reference (`-a oracle`), three agent games (`-a opencode`, one per world), do-nothing (`-a nop`) and stop-early
(the reference for months 0–2, then nothing). It prints the four rewards per world and the verifier's mistake report
for each agent game. Each game has a 30-minute budget, and the reference plays in about 70 s.

The worlds are evaluation seeds 4, 8 and 9: the three whose reference reward is closest to the median of seeds 0–9.
This repo is public and the agent has internet access, so `JUDGE_KEY` hashes each seed into a private one (the same key
gives the same worlds on every run). The reference is deterministic for a seed. Without a key, Harbor reproduces
these numbers to the fourth decimal (`harbor/jobs/judge-{reference,nop,stop-early}-check/`):

| world | seed | reference | do-nothing | stop-early |
|---|---|---|---|---|
| gpu-world-a | 4 | 0.904 | 0 | 0 |
| gpu-world-b | 8 | 0.899 | 0 | 0 |
| gpu-world-c | 9 | 0.922 | 0 | 0.070 |

`harbor run -p harbor/gpu-world ...` plays a fresh random world per trial instead.

## Reward

Reward = (oracle net cost / agent net cost, capped at 1) × (share of the three training runs met). The oracle is the
same LP planner as the reference but given the true future (`world.score`). Missing a run keeps at most 2/3, so doing
nothing scores 0. The verifier scores from the world server's ledger, using a token the agent never sees.

Scripted ladder on evaluation seeds 0–9 (`python scripts/ladder.py 0 10`):

| | do-nothing | stop-early | spot-only | exploiter | committer | **reference** | oracle |
|---|---|---|---|---|---|---|---|
| mean net cost ($M) | 3,401 | 3,134 | 2,391 | 1,460 | 896 | **790** | 734 |
| mean reward | 0 | 0.023 | 0.096 | 0.374 | 0.806 | **0.922** | 1 |

The exploiter tries buy-and-flip GPUs, contracts running past the horizon, options bought and never used, and orders
left undelivered at the end. It costs at least 1.59× the reference on every seed.

**Reference** (`gpu_world/policies.py`, `gpu_world/lp.py`): a Bayesian filter over every hidden factor feeds a linear
programme solved over 24 futures sampled from the posterior, re-planned every month. It sees exactly what the agent
sees, and its settings were tuned on seeds 100+ only.

## Results: frontier agents

| Agent (Harbor + OpenCode) | Rules | Games | Agent reward | Reference, same worlds | Agent as % of reference |
|---|---|---|---|---|---|
| Gemini 4 Hydrogen | v5 (current) | 5 | 0.69–0.89 (mean 0.80) | 0.89–0.97 (mean 0.92) | 78–97% (mean 87%), below in 5 of 5 |
| Claude Fable 5 | v4 (legacy) | 1 | 0.64 | 0.97 | 65% |

Per-game results are in [`harbor/jobs/hydrogen-v5-paired/PAIRED.md`](harbor/jobs/hydrogen-v5-paired/PAIRED.md) and
[`harbor/jobs/fable-5-v4/REPORT.md`](harbor/jobs/fable-5-v4/REPORT.md). Every verifier run attaches a mistake report
that compares the agent's game with the reference's on the same world (`diagnosis` in `verifier/details.json`;
`python gpu_world/compare.py harbor/jobs/<job>` prints it). Across Hydrogen's five games:

- **It buys a hardware pile early.** It spends $427–730M on GPUs where the reference spends
  $49–231M, pays $26–97M more for power, and gets only part of that back from resale and the end-of-game mark.
- **It over-fills the first training run.** It delivers 1.18–2.07× the 60 kH-months that run 1 needs. The
  reference delivers 1.02–1.05× on every run.
- **It does not explore.** It never orders from broker B in 4 of 5 games (and from neither broker in 2), while its
  own notes call the brokers untested for up to 23 months. The reference probes both brokers in month 0.
- **It reads the market correctly.** Its notes name the supply regime correctly in 89 of the 101 months where they
  state one. The gap is in its decisions, not in missing information.

Fable 5 shows the same over-commitment on credit. It bought 2.15× the compute that window 1 needed, which took its
cash down to −$343M and cost $70M in interest (the reference paid none).

## Results: training a small open model

_Placeholder: results of the RL post-training run in progress._

## Compute

- **Gemini API:** the frontier runs above are Gemini 4 Hydrogen (`gemini/gemini-4-hydrogen`) inside OpenCode, run
  through Harbor with the key passed via `--api-key-name GEMINI_API_KEY`.
- **Verda cloud:** the open-weight model is post-trained on on-demand Verda GPU instances, which
  `train/cloud/box.py` creates and deletes (on the `train` branch, PR #1).

## Layout

| Path | What it is |
|---|---|
| `TASK.md` | the rules the agent reads |
| `judge.sh` | the one-command evaluation |
| `gpu_world/` | the environment: simulator (`world.py`), command interface (`service.py`), Harbor world server (`server.py`), reference, oracle and baselines (`policies.py`, `lp.py`), mistake report (`compare.py`) |
| `harbor/gpu-world/`, `harbor/judge/` | the Harbor tasks (random world per trial; the three judge worlds), generated by `scripts/build_harbor.py` |
| `harbor/jobs/` | recorded Harbor runs, with write-ups |
| `scripts/` | offline tools: `ladder.py` (the table above), `gap.py` (an offline stand-in for the frontier gap), `tune_lp.py` (reference tuning), `missrate.py` (reference run misses), `trace.py` (one policy's trajectory) |
| `globe/` | 3D replay of recorded games (`globe/globe.html`) |

Inside the Harbor task, the agent's container has only a `gpu` client. The world runs in a sidecar container, so there
are no game files or seeds for the agent to read.
