> **Archive: GPU World v3 (single site).** These results were produced by the v3 code, tagged `gpu-world-v3`.
> The current code is v4 (three sites, options), so to reproduce or replay anything here run
> `git checkout gpu-world-v3` first. Paths below are relative to that version (`runs/` is now `results/v3/opus_runs/`).

# GPU World v3: gap experiment (14 Nov 2026)

Agent: Claude Code headless (`claude-opus-5-5`), isolated (only `python gpu.py`; no web, MCP or hooks).
2 attempts on each of the pre-registered evaluation seeds 0–2, about $0.8–1.1 and 27–28 turns per run.
Score = oracle net cost / agent net cost (the Harbor reward); per seed 0.7 × mean + 0.3 × worst attempt.

| seed | do_nothing | stop_early | spot_only | exploiter | heuristic (v2 reference) | **reference** | oracle | LP bound | **Opus runs** | Opus score | reference score |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 3660 | 2887 | 2196 | 1321 | 933 | **728** | 640 | 626 | 927, 1003 | 0.66 | 0.88 |
| 1 | 2978 | 1917 | 1775 | 2472 | 1002 | **779** | 693 | 672 | 1057, 1064 | 0.65 | 0.89 |
| 2 | 3067 | 2266 | 1457 | 1138 | 850 | **705** | 611 | 577 | 888, 996 | 0.64 | 0.87 |

Net cost in $M (lower is better). All Opus runs met all three training runs and wrote a belief note every month.

## Verdict: GO
- **Gap:** the reference beats Opus in **6/6** runs, by 26–41% in net cost. The scores are 0.65 against 0.88, and Opus's
  per-run scores sit in a tight 0.61–0.69 band, so the gap is reproducible.
- **Opus is far above the naive ladder.** It lands near the v2 hand-written planner (heuristic), which the v3 reference beats by 20%.
- **Reward integrity:** do-nothing 0.20, stop-early 0.31, spot-only 0.39 and the exploiter 0.49 (buy-and-flip, contracts
  past the horizon, undelivered orders at the end) all sit far below the reference on the Harbor task seed.

## Why Opus loses: decisions, with the information available

Breakdown from `python compare.py`:

| | reference | Opus (6 runs) |
|---|---|---|
| compute delivered in window 1 (need 60) | 72–91 | 94–145 |
| compute delivered in window 2 (need 140) | 150–157 | 188–269 |
| hardware capex ($M) | 143–556 | 532–1071 |
| lowest cash balance ($M) | +185 to +250 | −76 to −379 (2%/month interest) |
| broker exploration | probes A and B at month 0 | 4 of 6 runs never tried one of the two brokers |

1. **Over-insurance across training windows.** Compute does not carry between windows, yet Opus buys hardware early "because
   owning is cheaper than renting". It runs windows 1–2 at 1.3–2.4× what they need and borrows to do it. This was also its v2 failure.
2. **It knows, but it doesn't act (the knowing-doing gap).** Seed 2, month 6 note: *"Window1 will complete this month, window2
   has big surplus"*. The same note then plans to "buy ~5k more H around m10".
3. **Exploration and small-sample overconfidence.** Both seed-2 runs used only the cheaper broker A ("Broker A 2/2
   reliable-ish"). A is actually the unreliable one (35% delivery) and got lucky twice. B, the reliable one, was never tried.
4. **Belief is mostly right; action lags.** The notes read the regime, launch window and growth sensibly, as STOCKTAKE found for
   other models. The cost comes from turning beliefs into commitments.

## The reference
A Bayesian filter over every hidden factor. Each month it solves an LP over 12 futures sampled from the posterior, with
decisions for the next 3 months shared across futures, and plays this month's decisions. It sees exactly what the agent sees.
Its knobs were tuned on seeds 100+.

- The oracle (the same LP on the true future) is within about 2% of the LP relaxation bound, which validates the model.
- The value of hidden information is reference − oracle, about 9% on seeds 0–9.

## Harbor
`harbor run -p harbor/gpu-world -a oracle` scores **0.893** (log: `harbor/jobs/oracle-3/`). The world runs in a sidecar
container with a secret seed. The agent reaches it only over the network, and the verifier settles the books with a token the agent never sees.

## Caveats
- Only Claude Opus has played v3, through `claude -p`. The challenge harness is OpenCode, and it needs an API key we don't have on this machine.
- 3 seeds × 2 attempts. More seeds and other models would tighten the claim.
- The reference misses a training run in about 10% of training-seed worlds where the market turns tight late. That's the
  cost of not knowing the future, which the oracle doesn't pay.

## Gemini 4 via Harbor + OpenCode (added later the same day)
Each trial plays a fresh random world, so compare against the reference on the same world. Reward = oracle cost ÷ agent cost.

| Model, time limit | Months played | Gemini reward | Reference, same world | Gemini as % of reference |
|---|---|---|---|---|
| Hydrogen, 30 min | 24 (finished) | 0.86 | 0.92 | 94% |
| Hydrogen, 30 min | 21, then timed out | 0.93 | 0.98 | 95% |
| Hydrogen, 30 min | 24, timed out at the end | 0.74 | 0.91 | 82% |
| Carbon, 10 min (3 runs) | 2–6 | 0.25–0.37 | 0.87–0.94 | 29–40% |
| Carbon, 30 min (2 runs) | 9, 11 | 0.37, 0.30 | 0.93, 0.80 | 37–40% |

- **Hydrogen** never beat the reference (it won 3 of 3). But at about 90% of the reference it is on the go/no-go line, so the large gap is an Opus result, not yet a general one.
- **Carbon** takes about 90 s per step and analyses for 8–12 minutes before its first move, so it cannot finish 24 months in 30 minutes; its scores measure speed.
- Logs: `harbor/jobs/gemini-4-hydrogen-30min/`, `gemini-4-carbon-30min/`, `gemini-4-carbon-10min/`.
