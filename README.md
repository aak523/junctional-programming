# GPU World

The agent is compute procurement lead at an AI lab for 24 months. It must finish three training runs inside
their windows and serve growing inference demand, at the lowest settled net cost. It buys GPUs from a vendor
(slow, allocated) or two brokers (fast, possibly unreliable), reserves cloud capacity, rents spot, signs power,
resells hardware and manages cash on a credit line. The rules the agent gets are in [TASK.md](TASK.md).

## Why it is hard: where 2025–26 research says agents fail

| Mechanic | Failure it targets | Evidence |
|---|---|---|
| Two brokers whose reliability is learned only by ordering; a reliable one can decay silently | exploration; judging suppliers on price; acting on stale beliefs | Krishnamurthy et al. 2024 (in-context exploration); RetailBench 2026 (supplier choice on surface signals) |
| Inference growth switches silently mid-episode; the regime switches without notice | noticing silent change and acting on it (the knowing-doing gap) | STOCKTAKE 2026; WildGrid 2026 |
| Long lead times, FIFO allocation, power lead times, windowed training runs | in-transit orders and long-horizon commitments | Beer Game LLM studies (AAMAS 2026, Long et al. 2026); AIM-Bench |
| Cash plus a credit line at 2%/month | over-insurance (Opus's v2 failure mode) | our v2 runs; newsvendor bias studies |
| Several attempts per world; score = 0.7 mean + 0.3 worst attempt | run-to-run reliability | τ-bench pass^k; Long et al. "agent bullwhip"; Vending-Bench |
| Monthly `note` belief log | separates *knowing* from *doing* when explaining failures | STOCKTAKE |

## Design

- **Seeded, no LLM inside the world.** `world.py` draws all exogenous randomness at construction.
- **Hidden state:**
  - the supply regime;
  - the gen N launch month;
  - export controls;
  - inference growth and its silent switch;
  - broker reliability and its silent decay.

  The structure and priors are all in TASK.md; only the realised values are hidden.
- **Fair reference, true bound** (`lp.py`, `policies.py`):
  - **reference:** a Bayesian filter over every hidden factor feeds a linear programme (LP). Each month it solves the LP over 12 futures sampled from the posterior, keeps decisions for the next 3 months common to all futures, and plays this month's. It sees exactly what the agent sees, and its few knobs were tuned on seeds 100+ only.
  - **oracle:** the same LP on the true future, played in the real world.
  - **lp_bound:** that LP solved once over the whole horizon, a relaxation of the world.
  - **Value of hidden information** = reference − oracle.
- **Isolation:** the agent's only tool is `python gpu.py "<cmd>; <cmd>"`. The world state lives outside its directory and is rebuilt by replaying the action log. A probe agent could not read the simulator or the seed.

## Harbor task (`harbor/gpu-world/`)

Generated from these sources by `python build_harbor.py` (seed 20261114; a fresh verifier token on each build).
- `environment/`: the agent's container (`main`) gets only a `gpu` client. The `world` sidecar runs `server.py` with the
  simulator, the secret seed and the episode state. The agent's network is restricted to its model provider.
- `tests/`: settles the episode on the sidecar with a token the agent never sees, then writes
  `reward = oracle net cost / agent net cost` (0..1) to `/logs/verifier/reward.txt` and details to `details.json`.
- `solution/`: the reference policy, playing through the same server API.

```
harbor run -p harbor/gpu-world -a oracle                          # reference solution: reward 0.893 (log in harbor/jobs/oracle-3)
harbor run -p harbor/gpu-world -a opencode -m openai/<model>      # needs OPENAI_API_KEY (or google/..., GEMINI_API_KEY)
```

Ladder on the task seed (reward): do_nothing 0.204, stop_early 0.305, spot_only 0.387, exploiter 0.490,
heuristic 0.779, **reference 0.893**, oracle 1.000.

## Run it

```
python ladder.py 0 10 results/ladder.json   # scripted ladder + LP bound on evaluation seeds 0..9 (~1 min)
python run_all.py 0,1,2 2                   # 2 headless Claude Code attempts per seed, then results/table.md
python run_all.py summary                   # re-score existing runs
python trace.py heuristic 3                 # month-by-month trajectory of a ladder policy
```

## Ladder (mean net cost over evaluation seeds 0–9, $M; lower is better)

| do_nothing | stop_early | spot_only | exploiter | heuristic (v2 reference) | **reference** | oracle | LP bound |
|---|---|---|---|---|---|---|---|
| 3251 | 2344 | 2172 | 2211 | 1049 | **837** | 761 | 725 |

Every baseline and exploit costs at least 1.6× the reference on every seed. The exploits tried were buy-and-flip GPUs, long contracts past the horizon, a pile of undelivered orders at the end, and stopping after 3 months.

## Results: Opus 5.5 vs the reference ([results/SUMMARY.md](results/SUMMARY.md))

The reference beats Opus in **6/6** runs (seeds 0–2, 2 attempts each). Score 0.65 vs 0.88; Opus's net cost is 26–41% higher.
Opus consistently over-insures the early training windows (1.3–2.4× the compute they need, bought on credit), plans
to keep buying in the same note that says it already has a big surplus, and in 4/6 runs never tries one of the brokers.
`python compare.py` reproduces the breakdown.

Earlier versions: `results/SUMMARY_v2.md`, `runs_v1/`, `runs_v2/`.
