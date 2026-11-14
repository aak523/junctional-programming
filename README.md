# GPU World

An RL environment for the AfterQuery "Break the Agent" track (Junction 2026). The agent is compute procurement lead at
an AI lab for 24 months across three sites (`us`, `eu`, `ap`). It must finish three training runs inside their windows
and serve each site's inference demand at the lowest settled net cost. To do that it buys GPUs from a vendor (slow,
allocated) or two brokers (fast, possibly unreliable), reserves cloud capacity, buys and exercises capacity options,
rents spot, signs power, moves and resells hardware, and manages cash on a credit line. The rules the agent gets are in
[TASK.md](TASK.md).

## Status (14 Nov 2026)

This README is the single source of truth for results and design: update figures here, nowhere else.
(`results/v3/SUMMARY.md` is a frozen archive of the v3 runs.)

| Model | World | Games | Model reward | Reference reward, same worlds | Model as % of reference |
|---|---|---|---|---|---|
| Gemini 4 Hydrogen (Harbor + OpenCode) | v4 | 3 | 0.74–0.90 (mean 0.82) | 0.86–0.89 (mean 0.87) | 85–101% (mean 94%) |
| Gemini 4 Hydrogen (Harbor + OpenCode) | v3 | 3 | 0.74–0.93 | 0.91–0.98 | 82–95% (mean ~90%) |
| Claude Opus 5.5 (`claude -p`) | v3 | 6 | 0.61–0.69 (mean 0.65) | 0.87–0.89 (mean 0.88) | ~74% |
| Gemini 4 Carbon (Harbor + OpenCode) | v3 | 5 | 0.25–0.37 | 0.80–0.94 | too slow to finish 24 months in 30 min |

Reward = oracle net cost / agent net cost (1 = as good as the perfect-information oracle; doing nothing scores about 0.2).

- **The reference beat Opus in 6 of 6 games**, by 26–41% in net cost. Opus over-provisions early training windows on
  credit, and keeps buying in the same note where it says it has a surplus.
- **Gemini 4 Hydrogen is close to the reference**: on v4 it beat it once (0.899 vs 0.891) and averaged 94% of it. v4's
  extra sites and options did not widen that gap. Hydrogen still over-provisions the early windows (91–108 kH-months
  vs 60 needed; 185–207 vs 140), buys and then dumps hardware ($275M of resales in one game), and skipped the brokers
  entirely in 2 of 3 games. But those mistakes cost it less than uncertainty costs the reference.
- So the demonstrated gap is model-specific. The levers left: strengthen the reference (its long commitments past month
  23 cost it about $47M in the game Hydrogen won), and run more games.

The v3 results and their logs are archived in [results/v3/](results/v3/SUMMARY.md); `git checkout gpu-world-v3` gives that code.

## Why it is hard: where 2025–26 research says agents fail

| Mechanic | Failure it targets | Evidence |
|---|---|---|
| Three sites: local inference demand, separate power, caps and prices; GPUs move at a cost | long-horizon bookkeeping across interacting parts | RetailBench 2026 (agents lose track of items over long horizons) |
| Capacity options (pay now for the right to reserve later at a fixed price, outside the caps) | valuing flexibility instead of over-committing | our Opus runs (over-insurance) |
| Two brokers whose reliability is learned only by ordering; a reliable one can decay silently | exploration; judging suppliers on price | Krishnamurthy et al. 2024; RetailBench 2026 |
| Inference growth switches silently; the regime switches without notice | acting on silent change (the knowing-doing gap) | STOCKTAKE 2026; WildGrid 2026 |
| Long lead times, first-in-first-out allocation, power lead times, windowed training runs | in-transit orders and long commitments | Beer Game LLM studies (AAMAS 2026; Long et al. 2026); AIM-Bench |
| Cash plus a credit line at 2%/month | over-insurance | our v2/v3 Opus runs |
| Several attempts per world; score = 0.7 mean + 0.3 worst attempt | run-to-run reliability | τ-bench pass^k; "agent bullwhip"; Vending-Bench |
| Monthly `note` belief log | separates knowing from doing when explaining failures | STOCKTAKE |

## Design

- **Seeded, no LLM inside the world.** `world.py` draws all randomness up front, so every policy faces the same world for a seed.
- **Hidden state:** the supply regime, the gen N launch month, export controls, inference growth and its silent switch,
  and broker reliability and its silent decay. The structure and priors are all in TASK.md; only the realised values are hidden.
- **Reference, oracle and bound** (`policies.py`, `lp.py`):
  - **reference:** a Bayesian filter over every hidden factor feeds a linear programme. Each month it solves the LP
    over 12 futures sampled from the posterior, keeps the next 3 months of decisions common to all of them, and plays
    this month's. It sees exactly what the agent sees, and its knobs were tuned on seeds 100+ only.
  - **oracle:** the same LP given the true future, played in the real world. It is a strong benchmark, not a strict
    bound (the reference occasionally beats it).
  - **LP bound:** the LP solved once over the whole horizon, a relaxation of the world.
- **Isolation (Harbor):** the agent's container has only a `gpu` client. The world runs in a sidecar container that draws
  a secret 48-bit seed per trial; the verifier settles the episode with a token the agent never sees.

## Ladder (v4, mean net cost over evaluation seeds 0–9, $M; lower is better)

| do_nothing | stop_early | spot_only | exploiter | **reference** | oracle | LP bound |
|---|---|---|---|---|---|---|
| 3,296 | 2,613 | 2,331 | 1,685 | **818** | 751 | 701 |

Every baseline and exploit costs at least 1.7x the reference on every seed. The exploits tried were buy-and-flip GPUs,
contracts past the horizon, options bought and never used, undelivered orders at the end, and stopping after 3 months.

## Run it

```
# Harbor (needs Docker and `uv tool install harbor`)
harbor run -p harbor/gpu-world -a oracle                                   # the reference solution
harbor run -p harbor/gpu-world -a opencode -m gemini/gemini-4-hydrogen \
    --api-key-name GEMINI_API_KEY -k 3 -n 3                                   # GEMINI_API_KEY in the shell environment
harbor run -p harbor/gpu-world -a opencode -m anthropic/<model> -k 3 -n 3  # ANTHROPIC_API_KEY

# Local tools
python ladder.py 0 10 results/ladder.json   # scripted ladder + LP bound on seeds 0..9 (a few minutes)
python run_all.py 0,1,2 2                   # headless Claude Code attempts (claude -p), then results/table.md
python compare.py                           # where each agent run's money went, vs the reference on the same world
python trace.py reference 3                 # month-by-month trajectory of a ladder policy
python build_harbor.py                      # regenerate harbor/gpu-world from the sources
```

Each Harbor trial writes `verifier/reward.txt` and `verifier/details.json` (the world's seed, the reference and
do-nothing scores for that world, the agent's belief notes and actions).

## Layout

| Path | What it is |
|---|---|
| `world.py` | the simulator |
| `lp.py`, `policies.py` | the LP model, the Bayesian reference, the oracle and the baselines |
| `service.py`, `server.py` | the command interface (local) and the Harbor sidecar server |
| `TASK.md` | the rules the agent reads |
| `build_harbor.py`, `harbor/gpu-world/` | the Harbor task and its generator |
| `harbor/jobs/` | v4 Harbor runs (reference solution, Gemini 4 Hydrogen) |
| `results/ladder.json` | the v4 ladder |
| `results/v3/` | v3 summary, Opus runs and Gemini logs (code: tag `gpu-world-v3`) |
| `docs/HANDOFF.md` | the original challenge brief and design notes |
