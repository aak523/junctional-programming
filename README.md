# GPU World

The agent is compute procurement lead at an AI lab for 24 months. It must finish three training runs
inside their windows and serve growing inference demand, at the lowest settled net cost. It does this
by buying GPUs (long, allocated lead times), reserving cloud capacity, renting spot, signing power and
reselling hardware. The full rules the agent gets are in [TASK.md](TASK.md).

- **Seeded, no LLM inside the world.** `world.py` draws all exogenous randomness at construction, so every
  policy faces the same world for a given seed.
- **Hidden state:** the supply regime (loose/tight, switches 10%/month), the next-generation launch month
  (11–18), export controls (50%, months 5–15), and inference growth (3% or 7%/month). The structure and
  priors are all in TASK.md; only the realised values are hidden. Evidence comes from noisy headlines,
  prices, and "costly interaction": what your queue actually ships and what reservations and spot you actually get.
- **Time is operations:** at most 6 actions per month, then `end_month`.
- **Settled ledger:** spend − resale − GPUs marked at 75% of used value + obligations past month 23 +
  training-run penalties ($200M + $5M per kH-month short).

## Run it

```
python ladder.py 0 10            # scripted ladder on evaluation seeds 0..9 (~2 s)
python run_all.py 0,1,2,3 1      # one headless Claude Code attempt per seed, then results/table.md
python run_all.py summary        # re-tabulate existing runs
python trace.py reference 3      # month-by-month trajectory of one policy (shows hidden state)
```

The agent runs as `claude -p` in `runs/<seed>_<attempt>/`. Its only tool is
`python gpu.py "<cmd>; <cmd>"`, which forwards to `service.py`. The service keeps `{seed, action log}` in `state/`
(outside the run dir) and rebuilds the world by replay on each call. Permission rules deny reading or
running anything else. We checked this with a probe agent: reading `../../world.py`, `type` on the state file and `python -c open(...)` were all denied.

## Policy ladder (`policies.py`)

| policy | what it does |
|---|---|
| do_nothing | no actions |
| stop_early | the reference for months 0–2, then nothing (contracts and standing spot continue) |
| spot_only | myopic: never buys hardware; rents the gap on spot or 6-month reservations |
| exploiter | reference plus hacks: buy-and-flip GPUs, long contracts past the horizon, pile of undelivered orders at the end |
| **reference** | Bayesian filter over regime (headlines, spot ratio, index drift, shipments) and launch month (rumours, confirmations); replans every month: buys GPUs at the latest safe month in tranches, starts reservations early enough under the monthly cap, keeps power ahead at the worst-case lead time, spot plus a 5% buffer |
| clairvoyant | the same planner given the true hidden path. A perfect-information heuristic, **not** an upper bound |

Reference parameters were grid-tuned on seeds 100–139 only (`tune.py`); evaluation uses seeds 0–9.
