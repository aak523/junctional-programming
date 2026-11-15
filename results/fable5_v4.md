# Claude Fable 5 on GPU World v4 (14 Nov 2026)

Agent: **opencode 1.19.5** driving `anthropic/claude-fable-5`, run through Harbor 0.26.0 on the v4
`harbor/gpu-world` task. One game, 30-minute agent budget, random world per trial.
Reward = oracle net cost / agent net cost.

```
harbor run -p harbor/gpu-world -a opencode -m anthropic/claude-fable-5 -e podman \
  -o harbor/jobs --job-name fable-5-v4 --env-file <key.env> -y
```

Logs: [`harbor/jobs/fable-5-v4/`](../harbor/jobs/fable-5-v4/), trial `gpu-world__BpnMWA6`,
world seed `34024457028360`.

## Result

| | reward | net cost ($M) |
|---|---|---|
| **Fable 5** | **0.6362** | **1141** |
| reference, same world | 0.9734 | 746 |
| oracle, same world | 1.0000 | 726 |
| do_nothing, same world | 0.2437 | 2980 |

Fable spent **53% more than the reference** and reached **65% of its reward** — the widest gap any model
has shown on v4 so far (Gemini 4 Hydrogen: 85–101%, mean 94%). Caveat: one game, and each trial draws a
different world, so this is a like-for-like comparison *within* its world only.

The run itself was clean: 24/24 months played, 54 actions, **all three training-run milestones met, zero
penalties**, no exceptions. **It did not run out of time** — agent execution took **13m02s of the 30
minutes** (environment setup 6s, verifier 6s). Cost $4.75 (1.43M input tokens, essentially all cached;
6.5k output).

## Where the money went

Replay of the trial's action log against the reference on the same world (`python compare.py`):

| | net | capex | contracts | power | spot | interest | resale | mark | oblig | min cash |
|---|---|---|---|---|---|---|---|---|---|---|
| reference | 746 | 526 | 289 | 138 | 36 | **0** | 0 | 328 | 50 | **+191** |
| fable-5 | 1141 | **1012** | 273 | 180 | 5 | **70** | −169 | 335 | 71 | **−343** |

Compute delivered per training window: `[129, 264, 356]` against requirements `[60, 140, 320]`.
The reference delivered `[92, 145, 340]`.

**Failure mode: over-insurance financed on the credit line.** Fable bought nearly double the hardware
(capex $1012M vs $526M), front-loading a ~37k H fleet by month 7 — 2.15x what window 1 needed, 1.9x
window 2. That drove cash to **−$343M** on the 2%/month credit line (**$70M of interest**; the reference
never went negative), added $42M of power for the oversized fleet, and forced a liquidation in months
19–23 that recovered only $169M. It also bought 30 capacity options ($30M) and exercised 10.

It is the same over-provisioning Gemini 4 Hydrogen shows (91–108 kH-months against the 60 window 1 needs),
but more expensive, because Fable financed it on the credit line instead of out of cash and then sold the
surplus back at a loss.

## The knowing–doing gap

The monthly belief notes are coherent and mostly correct, which makes this a *doing* failure rather than
a reasoning failure. Hidden state on this world: regime `ttttlllttttttttttttttttt`, gen N launch month
**13**, no export controls, inference growth 3% with no switch, both brokers unreliable.

- **Read the world well.** Caught the regime flip to loose at M5 and back to tight at M9 from shipment
  volumes and spot/index. Intersected launch rumours to "m12–13" by M5, confirmed at M12 (true: 13).
  Tracked 3% growth correctly for 20 months.
- **Knew it was over-bought and kept the fleet anyway.** M6: *"coast m7-11 (capacity ~37-42 vs demand
  ~7-8)"* — about 5x inference demand in hand, window 1 already met at 129/60, no trim.
- **Hedged a shock that never came.** M0: *"front-load H (export-control risk)"*. Defensible at a 50%
  prior; the magnitude was the problem.
- **Thin exploration.** Ordered from broker A three times (delivered, cancelled, delivered), concluded
  *"coin flip, avoid"* at M5, and **never tried broker B at all**. Both brokers were in fact unreliable
  here so it cost little, but it repeats the blind spot Hydrogen shows in 2 of 3 games.
- **One wrong belief, correctly discounted.** At M21 it decided growth had switched to 7% (it had not)
  and noted it was *"safe either way"* — it was.
- **M18:** *"20 options likely expire unused - fine."* They did.

## Reference spread, for calibration

[`harbor/jobs/oracle-v4b/`](../harbor/jobs/oracle-v4b/) is a reference-only run on a different random
world: reward **0.717**, where the reference missed the month-15 milestone and took a $210M penalty.
Against `oracle-v4`'s 1.000, that shows how wide the per-world spread is — single-game comparisons
across different worlds are not meaningful, which is why every row above is same-world.

## Reproducing on a host without Docker

This run used rootless podman, since Docker was unavailable (Arch Linux, no root):

- `uv tool install harbor` (0.26.0); `npm i -g opencode-ai@1.19.5`.
- podman 6.1.4 + a Compose v2 binary on `PATH` as `docker-compose` +
  `systemctl --user enable --now podman.socket`.
- Every harbor run then needs **`-e podman`**; `--env-file` carries `ANTHROPIC_API_KEY`.

Analysis commands:

```bash
python compare.py                                                     # the cost table above, for every trial in harbor/jobs
cat harbor/jobs/fable-5-v4/gpu-world__BpnMWA6/verifier/details.json   # settlement, seed, monthly notes
tail -f harbor/jobs/<job>/gpu-world__*/agent/opencode.txt             # live agent stream
harbor view harbor/jobs                                               # trajectory browser
```
