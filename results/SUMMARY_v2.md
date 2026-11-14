# GPU World: gap experiment (14 Nov 2026)

Agent: Claude Code headless (`claude-opus-5-5`), isolated (no MCP, hooks or web; only `python gpu.py`).
One attempt per seed on evaluation seeds 0–6, about $0.5–1.0 and 19–30 turns per run. The reference was tuned on seeds 100–139.
Net cost in $M (lower is better); training runs met out of 3 in brackets.

| seed | do_nothing | stop_early | spot_only | exploiter | **reference** | clairvoyant* | **Opus** |
|---|---|---|---|---|---|---|---|
| 0 | 3660 (0) | 2395 (1) | 2196 (0) | 1948 (2) | **909 (3)** | 921 (3) | 1351 (3) |
| 1 | 2978 (0) | 1903 (1) | 1775 (2) | 3096 (1) | **960 (3)** | 930 (3) | 1268 (3) |
| 2 | 2993 (0) | 2331 (1) | 1368 (2) | 2042 (2) | 800 (3) | 797 (3) | **695 (3)** |
| 3 | 3634 (0) | 2741 (1) | 3228 (1) | 5127 (0) | **1509 (3)** | 1503 (3) | 1718 (3) |
| 4 | 3629 (0) | 2811 (0) | 2601 (1) | 2280 (3) | 1111 (3) | 1160 (3) | **1073 (3)** |
| 5 | 2991 (0) | 2312 (1) | 2090 (1) | 2821 (1) | **1085 (3)** | 960 (3) | 1237 (3) |
| 6 | 3644 (0) | 2578 (1) | 2856 (1) | 4259 (0) | 1416 (3) | 1244 (3) | **1274 (3)** |
| mean | 3361 | 2439 | 2302 | 3082 | **1113** | 1073 | 1231 |

*clairvoyant = the reference planner given the true hidden path. It is a heuristic, not an upper bound.

## Verdict: no-go as is
- The reference beats Opus on 4 of 7 seeds. On average Opus costs 10.6% more ($118M). On the three seeds never
  looked at while improving the reference (4–6), Opus wins 2 of 3. Opus is at about 90% of the reference, which is the
  handoff's "kill or rework" line. There is no consistent, reproducible gap yet.
- Opus beats every naive baseline by a wide margin and met all three runs in all 7 valid episodes.
- Reward integrity holds against the scripted attacks. Do-nothing, stop-early (reference for 3 months, then stop),
  spot-only and the exploiter (buy-and-flip, long contracts past the horizon, a pile of undelivered orders at the end) all cost
  1.7–4.0x the reference on every seed. Non-finite quantities are rejected and `calc` exponents are bounded.

## The agent's failure mode is consistent, but it doesn't always cost it
Compute doesn't carry between training windows, yet Opus over-provisions the early windows in 6 of 7 runs:

| window (need) | Opus range | reference range |
|---|---|---|
| months 0–7 (60) | 67–182 | 63–89 |
| months 8–15 (140) | 158–380 | 166–205 |

It buys or reserves for the final run at month 0–3: up to 50k gen H in months 0–2, and 24-month
reservations of 3–10 kH/month in months 0–3. It then pays for idle hardware, keeps H through the 40% launch
write-down, and resells at 75% of value in the last months. Its capex is higher than the reference's on 6 of 7 seeds.
It wins when the reference's own commitments run long (reference obligations of $125–189M on seeds 2, 4, 6).

## Things the agent taught us (both fixed in the design)
1. **v1 leaked the regime.** Used gen H value carried an exact x1.1 premium while tight, and Opus spotted it
   ("used-GPU prices had a 1.1x premium, which gave away whether supply was tight or loose"). It was removed. Contract-index
   and spot noise were raised (5%, 30%) so the free signals are informative but not decisive. The two v1 runs are in `runs_v1/`.
2. **Renting can beat owning.** On seed 2, Opus rented the final window (10 kH/month of 6-month reservations at
   falling loose-market prices) instead of owning gen H that loses 40% at launch. The reference now applies an
   expected-cost own-vs-rent test and allows reservations that overshoot month 23. That cut its mean cost from 1182 to 1034 on seeds 0–9.

## What would make a gap (rework options)
- Most of the cost difference is planning structure, not hidden state: with true hidden state, the same planner improves by only about 4%.
  The hidden variables need more leverage. Make the launch date and regime matter more, for example a bigger launch
  write-down, longer regime spells with rarer switches, export controls that cancel queued orders, or demand-growth uncertainty
  that is resolved only through the agent's own inference traffic.
- The agent's real weakness is over-insurance across windows. Tighten capital so over-provisioning binds, for example a cash
  budget or credit line with interest, so early hoarding hurts every time rather than only sometimes.
- Run 2+ attempts per seed for variance. Two second attempts this session were lost to a mid-run logout (`Not logged in`);
  they are excluded and kept in `runs_v1/invalid_auth_*`.
