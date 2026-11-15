# GPU World

An RL environment for the AfterQuery "Break the Agent" track (Junction 2026). The agent is compute procurement lead at
an AI lab for 24 months across three sites (`us`, `eu`, `ap`). It must finish three training runs inside their windows
and serve each site's inference demand at the lowest settled net cost. To do that it buys GPUs from a vendor (slow,
allocated) or two brokers (fast, possibly unreliable), reserves cloud capacity, buys and exercises capacity options,
rents spot, signs power, moves and resells hardware, and manages cash on a credit line. The rules the agent gets are in
[TASK.md](TASK.md).

## Judge it in one command

```
JUDGE_KEY=<any private words> ./judge.sh gemini/gemini-4-hydrogen --api-key-name GEMINI_API_KEY --env-file .env
```

`judge.sh` (bash, Docker and `uv tool install harbor`) runs the standard harness on three fixed worlds,
`harbor/judge/gpu-world-{a,b,c}`: the reference (`-a oracle`), three agent games (`-a opencode`, one per world),
do-nothing (`-a nop`) and stop-early (`-a oracle --ae STOP_AFTER=3`: the reference for months 0..2, then nothing). It
ends with one table of the four rewards per world and the verifier's mistake report for each agent game.

The worlds are evaluation seeds 4, 8 and 9: the three whose reference reward is closest to the median of seeds 0–9,
not its best worlds. Their seeds are in this public repo and the agent has internet access, so set `JUDGE_KEY`: it
turns each seed into a private one, the same on every run with the same key. The reference is deterministic for a
seed, so it reproduces exactly. Without a key it scores the numbers below.

| world | seed | reference | do-nothing | stop-early |
|---|---|---|---|---|
| gpu-world-a | 4 | 0.904 | 0 | 0 |
| gpu-world-b | 8 | 0.899 | 0 | 0 |
| gpu-world-c | 9 | 0.922 | 0 | 0.070 |

## Status (15 Nov 2026)

| Model | World | Games | Model reward | Reference reward, same worlds | Model as % of reference |
|---|---|---|---|---|---|
| Gemini 4 Hydrogen, v5 games re-scored against the fixed reference and oracle | v5 | 5 | 0.69–0.89 (mean 0.80) | 0.89–0.97 (mean 0.92) | 78–97% (mean 87%) |
| Gemini 4 Hydrogen (Harbor + OpenCode), fixed seeds 1001–1005 | v5 | 5 | 0.69–1.00 (mean 0.85) | 0.84–0.92 (mean 0.88) | 82–110% (mean 96%, standard error 4.5%) |
| Gemini 4 Hydrogen (Harbor + OpenCode), fixed seeds 1001–1005 | v4 | 5 | 0.79–0.97 | 0.87–0.99 | 89–98% (mean 92%) |
| Gemini 4 Hydrogen (Harbor + OpenCode) | v4 | 3 | 0.74–0.90 (mean 0.82) | 0.86–0.89 (mean 0.87) | 85–101% (mean 94%) |
| Claude Fable 5 (Harbor + OpenCode) | v4 | 1 | 0.64 | 0.97 | 65% |
| Gemini 4 Carbon (Harbor + OpenCode) | v3 | 5 | 0.25–0.37 | 0.80–0.94 | too slow to finish 24 months in 30 min |

Reward = oracle net cost / agent net cost, capped at 1, times the share of the three training runs met (`world.score`;
1 = as good as the perfect-information oracle). Missing a run keeps at most 2/3, so doing nothing scores 0 and
stopping after 3 months 0.02 on average. Every game in the table met all three runs, so the scaling leaves it unchanged.
Per-seed results: `harbor/jobs/hydrogen-v5-paired/PAIRED.md`.

- **v5 changed the rules to price Hydrogen's hedge.** Inference grows 4% or 8% a month, gen N launches in months 9–15,
  used gen H loses 50% at launch, GPUs lose 4% of their value a month and positive cash earns 0.75% a month. Replaying
  Hydrogen's 8 recorded v4 games in the same worlds with only the cost changes dropped it from 91% to 84% of the reference.
- **The gap did not widen in play.** Hydrogen still buys a hardware pile early ($430–730M of GPUs vs the reference's
  $50–260M), over-fills the first window (71–124 kH-months vs 60) and never tries broker B, and it is below the
  reference in 4 of 5 games. But the same rules pushed the reference into leasing almost everything: in seed 1005
  (tight supply for 21 of 24 months, 8% growth) it bought $93M of GPUs, left $258M of contracts running past month 23,
  and lost to both Hydrogen and the oracle (which bought $265M).
- **Most of that was a bug in the planners, not the rules.** When the LP planned to buy capacity options and exercise
  them in the same month, the reference and the oracle exercised before buying, so the exercise slipped a month, and in
  tight supply the lost month had to be bought back at a premium. With options bought first, the oracle on seed 1005
  costs 1075 instead of 1226 (its LP bound is 1044) and the reference 1130 instead of 1354. The guard that exercised
  options a month before a deadline was patching the same bug; it is gone (on seed 1003 it cost $50M for nothing).
  Hydrogen's games do not depend on this code, so re-scoring them is exact: 87% of the reference, below it in all 5.
- **An offline stand-in measures the gap without model credits.** `Committer` is the reference made to buy
  Hydrogen's early fleet (9k gen H in months 0–2, 9k gen N at launch, at one site) and plan everything else around
  it. On the five paired worlds it scores 85–99% of the reference where Hydrogen's re-scored games are at 78–97%. `gap.py` plays it
  against the reference: on tuning seeds 100–139 it was at 90.0% of the reference (above it on 6 of 40) before the fix
  and 86.5% (standard error 1.4%, above it on 1) after; on evaluation seeds 0–9 it is at 87.2% (above it on none).
- **What is left between the reference and the oracle is mostly unknowable.** Revealing one hidden factor at a time
  to the reference (tuning seeds 100–111, a $50M gap): everything its filter estimates (the current regime, launch
  month, growth and broker reliability) together saves under $3M; the future supply path saves $30M (59% of the gap)
  and the future demand path $8M (15%). Re-tuned after the fix, sharing decisions across the sampled futures for 2
  months instead of 3 saves $8M (better on 11 of 12 seeds). A scenario tree (futures sharing their history and
  decisions in groups up to a branch month), 48 futures instead of 24, and the other knobs did not help.
- **Claude Fable 5 lost by the most so far**, at 65% of the reference in its one v4 game ([results/fable5_v4.md](results/fable5_v4.md)):
  it met all three windows with no penalties and finished in 13 of its 30 minutes, but bought 2.15x the compute window 1
  needed on the credit line ($70M of interest against the reference's zero), then liquidated the surplus at a loss.

The v3 Harbor logs are archived in `results/v3/`; `git checkout gpu-world-v3` gives that code.

## Why agents lose

Every verifier run attaches a mistake report (`diagnosis` in `details.json`, findings in `test-stdout.txt`): the
agent's game against the reference's on the same world. `python compare.py harbor/jobs/hydrogen-v5-paired` prints
it for Hydrogen's five v5 games. The pattern is the same in all five:

- **It buys a hardware pile early.** It spent $427–730M on GPUs against the reference's $49–231M and paid for it in
  power ($26–97M more), then took back only part of it in resale and the end-of-game mark.
- **It over-fills the first training run.** It delivered 1.18–2.07x the 60 kH-months run 1 needed; the reference
  delivers 1.02–1.05x on every run.
- **It does not explore.** It never ordered from broker B in 4 of 5 games (in 2, from neither broker) while its notes
  called the brokers untested or unknown in up to 23 months. The reference probes each broker in month 0.
- **It reads the market correctly.** Its notes named the supply regime right in 89 of the 101 months that stated one.
  The gap is in the decisions, not in missing information.

Claude Fable 5's v4 game ([results/fable5_v4.md](results/fable5_v4.md)) shows the same over-commitment on credit:
2.15x window 1's need, cash down to -$343M and $70M of interest against the reference's zero.

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
    over 24 futures sampled from the posterior, keeps this month's and next month's decisions common to all of them, and plays
    this month's. A guard covers the cliff of a missed training run: in a window's last month it tops up spot to the
    gap that capacity already certain leaves. It sees exactly what the agent sees,
    and its knobs were tuned on seeds 100+ only.
  - **oracle:** the same LP given the true future, played in the real world. It is a strong benchmark, not a strict
    bound (the reference occasionally beats it).
  - **LP bound:** the LP solved once over the whole horizon, a relaxation of the world.
- **Isolation (Harbor):** the agent's container has only a `gpu` client. The world runs in a sidecar container that draws
  a secret 48-bit seed per trial; the verifier settles the episode with a token the agent never sees.

## Ladder (v5, evaluation seeds 0–9)

| | do_nothing | stop_early | spot_only | exploiter | committer | **reference** | oracle | LP bound |
|---|---|---|---|---|---|---|---|---|
| mean net cost ($M) | 3,401 | 3,134 | 2,391 | 1,460 | 896 | **790** | 734 | 703 |
| mean reward | 0 | 0.023 | 0.096 | 0.374 | 0.806 | **0.922** | 1 | |

The reference meets all three training runs on every seed and scores 0.92 on average (0.85 at worst). Doing nothing
scores 0 and stopping after 3 months 0.023 (0.10 at most: it meets the first run on 3 of 10 seeds). Every baseline costs at least 2.5x the reference on every seed, the
exploiter at least 1.59x (1.86x on average), and the committer (early fleet, otherwise the reference) at least 1.05x
(1.16x on average). The exploits tried were buy-and-flip GPUs,
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
python gap.py 100 40                        # committer vs reference on tuning seeds 100..139: the offline gap (~15 min)
python tune_lp.py 12 7                      # one reference knob at a time on tuning seeds 100..111 (~20 min)
python compare.py harbor/jobs/<job>         # the mistake report for each trial, vs the reference on the same world
python trace.py reference 3                 # month-by-month trajectory of a ladder policy
python build_harbor.py                      # regenerate harbor/gpu-world from the sources
```

Each Harbor trial writes `verifier/reward.txt` and `verifier/details.json`: the world's seed, the reference,
do-nothing and stop-early scores on that world, the mistake report, and the agent's belief notes and actions.

## Layout

| Path | What it is |
|---|---|
| `world.py` | the simulator |
| `lp.py`, `policies.py` | the LP model, the Bayesian reference, the oracle and the baselines |
| `service.py`, `server.py` | the command interface and the Harbor sidecar server |
| `TASK.md` | the rules the agent reads |
| `build_harbor.py`, `harbor/gpu-world/` | the Harbor task and its generator |
| `judge.sh`, `harbor/judge/` | the judges' one-command evaluation and its three fixed-world tasks |
| `ladder.py`, `gap.py`, `tune_lp.py`, `compare.py`, `trace.py`, `missrate.py` | local tools (see Run it); `gap.py` is the offline proxy for a frontier agent's gap; `compare.py` also writes the verifier's mistake report |
| `harbor/jobs/` | v4 and v5 Harbor runs (reference solution, Gemini 4 Hydrogen, Claude Fable 5) |
| `results/ladder.json` | the v5 ladder |
| `results/fable5_v4.md` | the Claude Fable 5 game: cost breakdown against the reference on its world |
| `results/v3/` | v3 Gemini Harbor logs and ladder (code: tag `gpu-world-v3`) |
| `docs/HANDOFF.md` | the original challenge brief and design notes |
