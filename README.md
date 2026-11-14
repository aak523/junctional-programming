# GPU World

An RL environment for the AfterQuery "Break the Agent" track (Junction 2026). The agent is compute procurement lead at
an AI lab for 24 months across three sites (`us`, `eu`, `ap`). It must finish three training runs inside their windows
and serve each site's inference demand at the lowest settled net cost. To do that it buys GPUs from a vendor (slow,
allocated) or two brokers (fast, possibly unreliable), reserves cloud capacity, buys and exercises capacity options,
rents spot, signs power, moves and resells hardware, and manages cash on a credit line. The rules the agent gets are in
[TASK.md](TASK.md).

## Status (14 Nov 2026)

| Model | World | Games | Model reward | Reference reward, same worlds | Model as % of reference |
|---|---|---|---|---|---|
| Gemini 4 Hydrogen (Harbor + OpenCode), fixed seeds 1001–1005 | v5 | 5 | 0.69–1.00 (mean 0.85) | 0.84–0.92 (mean 0.88) | 82–110% (mean 96%, standard error 4.5%) |
| Gemini 4 Hydrogen (Harbor + OpenCode), fixed seeds 1001–1005 | v4 | 5 | 0.79–0.97 | 0.87–0.99 | 89–98% (mean 92%) |
| Gemini 4 Hydrogen (Harbor + OpenCode) | v4 | 3 | 0.74–0.90 (mean 0.82) | 0.86–0.89 (mean 0.87) | 85–101% (mean 94%) |
| Gemini 4 Carbon (Harbor + OpenCode) | v3 | 5 | 0.25–0.37 | 0.80–0.94 | too slow to finish 24 months in 30 min |

Reward = oracle net cost / agent net cost (1 = as good as the perfect-information oracle; doing nothing scores about 0.2).
Per-seed results: `harbor/jobs/hydrogen-v5-paired/PAIRED.md`.

- **v5 changed the rules to price Hydrogen's hedge.** Inference grows 4% or 8% a month, gen N launches in months 9–15,
  used gen H loses 50% at launch, GPUs lose 4% of their value a month and positive cash earns 0.75% a month. Replaying
  Hydrogen's 8 recorded v4 games in the same worlds with only the cost changes dropped it from 91% to 84% of the reference.
- **The gap did not widen in play.** Hydrogen still buys a hardware pile early ($430–730M of GPUs vs the reference's
  $50–260M), over-fills the first window (71–124 kH-months vs 60) and never tries broker B, and it is below the
  reference in 4 of 5 games. But the same rules pushed the reference into leasing almost everything: in seed 1005
  (tight supply for 21 of 24 months, 8% growth) it bought $93M of GPUs, left $258M of contracts running past month 23,
  and lost to both Hydrogen and the oracle (which bought $265M). The reference's lease bias in long tight stretches is
  now the main lever.

The v3 Harbor logs are archived in `results/v3/`; `git checkout gpu-world-v3` gives that code.

## Why it is hard: where 2025–26 research says agents fail

| Mechanic | Failure it targets | Evidence |
|---|---|---|
| Three sites: local inference demand, separate power, caps and prices; GPUs move at a cost | long-horizon bookkeeping across interacting parts | RetailBench 2026 (agents lose track of items over long horizons) |
| Capacity options (pay now for the right to reserve later at a fixed price, outside the caps) | valuing flexibility instead of over-committing | our Gemini runs (over-provisioning) |
| Two brokers whose reliability is learned only by ordering; a reliable one can decay silently | exploration; judging suppliers on price | Krishnamurthy et al. 2024; RetailBench 2026 |
| Inference growth switches silently; the regime switches without notice | acting on silent change (the knowing-doing gap) | STOCKTAKE 2026; WildGrid 2026 |
| Long lead times, first-in-first-out allocation, power lead times, windowed training runs | in-transit orders and long commitments | Beer Game LLM studies (AAMAS 2026; Long et al. 2026); AIM-Bench |
| Cash earns 0.75%/month, debt costs 2%/month; GPUs lose 4% of their value a month and 50% at the next-gen launch | over-insurance: idle cash and idle hardware both cost money | our Gemini runs |
| Monthly `note` belief log | separates knowing from doing when explaining failures | STOCKTAKE |

## Design

- **Seeded, no LLM inside the world.** `world.py` draws all randomness up front, so every policy faces the same world for a seed.
- **Hidden state:** the supply regime, the gen N launch month, export controls, inference growth and its silent switch,
  and broker reliability and its silent decay. The structure and priors are all in TASK.md; only the realised values are hidden.
- **Reference, oracle and bound** (`policies.py`, `lp.py`):
  - **reference:** a Bayesian filter over every hidden factor feeds a linear programme. Each month it solves the LP
    over 24 futures sampled from the posterior, keeps the next 3 months of decisions common to all of them, and plays
    this month's. A guard covers the cliff of a missed training run: in a window's last two months it tops up spot
    and, if tight spot caps could not close the gap, exercises capacity options. It sees exactly what the agent sees,
    and its knobs were tuned on seeds 100+ only.
  - **oracle:** the same LP given the true future, played in the real world. It is a strong benchmark, not a strict
    bound (the reference occasionally beats it).
  - **LP bound:** the LP solved once over the whole horizon, a relaxation of the world.
- **Isolation (Harbor):** the agent's container has only a `gpu` client. The world runs in a sidecar container that draws
  a secret 48-bit seed per trial; the verifier settles the episode with a token the agent never sees.

## Ladder (v5, mean net cost over evaluation seeds 0–9, $M; lower is better)

| do_nothing | stop_early | spot_only | exploiter | **reference** | oracle | LP bound |
|---|---|---|---|---|---|---|
| 3,401 | 3,073 | 2,391 | 1,407 | **838** | 796 | 703 |

The reference meets all three training runs on every seed and scores 0.92 on average (0.83 at worst). Doing nothing
scores 0.23 and stopping after 3 months 0.26. Every baseline costs at least 2.4x the reference on every seed, and the
exploiter at least 1.39x (1.68x on average). The exploits tried were buy-and-flip GPUs,
contracts past the horizon, options bought and never used, undelivered orders at the end, and stopping after 3 months.

## Run it

```
# Harbor (needs Docker and `uv tool install harbor`)
harbor run -p harbor/gpu-world -a oracle                                   # the reference solution
harbor run -p harbor/gpu-world -a opencode -m gemini/gemini-4-hydrogen \
    --api-key-name GEMINI_API_KEY -k 3 -n 3                                   # GEMINI_API_KEY in the shell environment
harbor run -p harbor/gpu-world -a opencode -m anthropic/<model> -k 3 -n 3  # ANTHROPIC_API_KEY

# Paired comparison on fixed worlds (what the status table reports): one task per seed, then run them all
for s in 1001 1002 1003 1004 1005; do python build_harbor.py --seed $s --out paired/v5-s$s; done
harbor run -p paired -a opencode -m gemini/gemini-4-hydrogen --api-key-name GEMINI_API_KEY --env-file .env -k 1 -n 4

# Local tools
python ladder.py 0 10 results/ladder.json   # scripted ladder + LP bound on seeds 0..9 (a few minutes)
python compare.py                           # where each Harbor trial's money went, vs the reference on the same world
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
| `service.py`, `server.py` | the command interface and the Harbor sidecar server |
| `TASK.md` | the rules the agent reads |
| `build_harbor.py`, `harbor/gpu-world/` | the Harbor task and its generator |
| `harbor/jobs/` | v4 and v5 Harbor runs (reference solution, Gemini 4 Hydrogen) |
| `results/ladder.json` | the v4 ladder |
| `results/v3/` | v3 Gemini Harbor logs and ladder (code: tag `gpu-world-v3`) |
| `docs/HANDOFF.md` | the original challenge brief and design notes |
