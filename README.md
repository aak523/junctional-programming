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

Every game ends with a **net cost**: everything the agent spent, minus resale income and the value of the hardware it
still owns, plus penalties for unserved demand and missed training runs. The reward compares that with the best cost
achievable on the same world, found by an **oracle** that is told the whole future in advance:

- Matching the oracle's cost scores 1; spending twice as much scores 0.5.
- That number is then multiplied by the share of the three training runs finished on time. Missing one run caps the
  reward at 2/3, and missing all three scores 0, so doing nothing scores 0.
- The score comes from the world server's own accounts, never from anything the agent reports.

Scripted strategies on evaluation seeds 0–9 (`python scripts/ladder.py 0 10`):

| Strategy | What it does | Mean net cost ($M) | Mean reward |
|---|---|---|---|
| do nothing | sends no commands | 3,401 | 0 |
| stop early | plays like the reference for 3 months, then stops | 3,134 | 0.023 |
| spot only | never buys hardware; rents just this month's shortfall in cloud capacity | 2,391 | 0.096 |
| exploiter | the reference plus every loophole we found: buying GPUs to flip, contracts that run past the last month, options never used, orders still undelivered at the end | 1,460 | 0.374 |
| committer | the reference, forced to buy a large fleet early the way the frontier agents do | 896 | 0.806 |
| **reference** | **our planner, which sees only what the agent sees** | **790** | **0.922** |
| oracle | the same planner, told the future | 734 | 1 |

The reference (`gpu_world/policies.py`, `gpu_world/lp.py`) keeps a probability estimate for each hidden factor and
updates it from what it observes. Each month it plans against 24 plausible futures drawn from those estimates, commits
only to the near-term decisions that work across all of them, and plans again the next month. Its settings were tuned
on seeds 100 and up, never on the evaluation or judge worlds.

## Results: frontier agents

Gemini 4 Hydrogen in the standard harness (Harbor + OpenCode), one game on each of three fixed worlds, with the
reference played on the same worlds:

| world seed | Gemini 4 Hydrogen | reference | Hydrogen as % of reference |
|---|---|---|---|
| 1001 | 0.792 | 0.928 | 85% |
| 1002 | 0.821 | 0.966 | 85% |
| 1003 | 0.693 | 0.889 | 78% |
| **mean** | **0.769** | **0.928** | **83%** |

Hydrogen scores below the reference on all three worlds and meets all three training runs in each, so the gap comes from
cost, not from missed runs. Per-game logs: [`harbor/jobs/hydrogen-v5-paired/`](harbor/jobs/hydrogen-v5-paired/PAIRED.md).
Every verifier run attaches a mistake report that compares the agent's game with the reference's on the same world
(`diagnosis` in `verifier/details.json`; `python gpu_world/compare.py harbor/jobs/<job>` prints it). Across the three
games:

- **It buys a hardware pile early.** It spends $558–730M on GPUs where the reference spends
  $49–214M, pays $26–97M more for power, and gets only part of that back from resale and the end-of-game mark.
- **It over-fills the first training run.** It delivers 1.18–1.91× the compute that run 1 needs. The
  reference delivers 1.03–1.05× on every run.
- **It does not explore.** It never orders from broker B in any of the three games (and from neither broker in two),
  while its own notes call the brokers untested for up to 23 months. The reference probes both brokers in month 0.
- **It reads the market correctly.** Its notes name the supply regime correctly in 53 of the 56 months where they
  state one. The gap is in its decisions, not in missing information.

## Results: training a small open model

We fine-tuned Qwen3-4B-Instruct-2507 (LoRA) on the environment's experience: behaviour cloning on the reference's
games, then DAgger rounds in which the reference relabels the states the student actually reached. The model plays one
month per message through the same command path as Harbor. Mean reward on 30 held-out worlds (greedy, this reward):

| policy | reward | worlds with all 3 runs met |
|---|---|---|
| do nothing | 0.00 | 0 / 30 |
| Qwen3-4B, untrained | 0.12 | 1 / 30 |
| after behaviour cloning (SFT) | 0.23 | 5 / 30 |
| after DAgger round 3 | 0.46 | 12 / 30 |
| **after DAgger round 4** | **0.57** | **21 / 30** |
| reference | 0.92 | 30 / 30 |

Each DAgger round beat the previous model on the same worlds: +0.225 over SFT (standard error 0.044) and then +0.112
(standard error 0.038). Changes to the SFT recipe (a short prompt, twice the data, Qwen3-8B, the fixed reference as
teacher) stayed within run-to-run noise, and DPO and imitating its own best games did worse than plain relabelling.
The best model still misses 10 of 90 training runs and over-leases. Method, all results and replay commands:
[train/README.md](train/README.md).

## Next: v6 rules (branch `v6`, not yet judged)

Three changes make over-commitment cost what it would in practice: GPU orders get dearer with volume (per source per
month: the first 3k at list price, the next 3k at +10%, beyond that +25%); debt beyond $200M costs 3.5% a month instead
of 2%; and a missed training run halves the next three funding payments. On tuning seeds 100–139 the reference and the
oracle still meet every run. A stand-in for Hydrogen's early fleet drops from 86.5% to 81.4% of the reference and never
beats it (0 of 40 worlds, against 1 under v5). A stand-in that buys ~20k GPUs early on credit lands at 70.2%. The judge
tasks and frontier games are still v5. To try it: `git checkout v6 && python scripts/gap.py 100 8` (~15 min).

## Compute

- **Gemini API:** the frontier runs above are Gemini 4 Hydrogen (`gemini/gemini-4-hydrogen`) inside OpenCode, run
  through Harbor with the key passed via `--api-key-name GEMINI_API_KEY`.
- **Verda cloud:** the open-weight model is post-trained on on-demand Verda GPU instances, which
  `train/cloud/box.py` creates and deletes: an A100 80GB for the main line and an 8x RTX PRO 6000 box for the
  follow-up experiments, $63 in total.

## Layout

| Path | What it is |
|---|---|
| `TASK.md` | the rules the agent reads |
| `judge.sh` | the one-command evaluation |
| `gpu_world/` | the environment: simulator (`world.py`), command interface (`service.py`), Harbor world server (`server.py`), reference, oracle and baselines (`policies.py`, `lp.py`), mistake report (`compare.py`) |
| `harbor/gpu-world/`, `harbor/judge/` | the Harbor tasks (random world per trial; the three judge worlds), generated by `scripts/build_harbor.py` |
| `harbor/jobs/` | recorded Harbor runs, with write-ups |
| `scripts/` | offline tools: `ladder.py` (the table above), `gap.py` (an offline stand-in for the frontier gap), `tune_lp.py` (reference tuning), `missrate.py` (reference run misses), `trace.py` (one policy's trajectory) |
| `train/` | fine-tuning Qwen3-4B on the environment's experience ([train/README.md](train/README.md)) |
| `globe/` | 3D replay of recorded games (`globe/globe.html`) |

Inside the Harbor task, the agent's container has only a `gpu` client. The world runs in a sidecar container, so there
are no game files or seeds for the agent to read.
