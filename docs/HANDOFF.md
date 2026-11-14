# Handoff: AfterQuery track, environment ideas and experiment setup

Source session: https://claude.ai/code/session_01EUC6VXyB25YyH1JvyuqtER (Junction 2026, 13–15 Nov, Helsinki)

## The AfterQuery "Break the Agent" challenge

Build an RL environment that challenges today's best agents, shows real failure modes, and has a reward that reflects real progress.

- Environment needs a clear goal, actions the agent can take, and a reward you can check.
- Run a frontier agent in it and compare against a **stronger reference run your team demonstrates**. Both must reproduce.
- Show where the agent falls short and why. Judges also try to find **reward hacks**.
- Optional stretch: train a smaller model on experience from the environment and show it improves (this is the tiebreaker).
- Prizes: €3,000 / €1,500 / €500. Winners skip to the final stage of AfterQuery's interview process (work trial).

**Rubric (100 points)**
- **Gap (30):** frontier agent consistently scores below the reference run across repeated runs. Zero if no measurable or reproducible gap.
- **Meaningful difficulty (30):** you can explain the agent's mistakes as decisions in the task, with the information and tools it needed available. Zero if the gap comes from withheld information, trick wording, impossible timing or broken tools.
- **Reward integrity (25):** the reward measures success and holds up against exploits; doing nothing or stopping early earns little. Zero if an exploit beats honest play.
- **Craft (15):** rules make sense; judges run the evaluation from the README with one command and reproduce the results.

**How judging runs:** a 10-minute demo, then judges rerun the evaluation with the standard harness: your reference run, 3 agent runs, a do-nothing baseline and a stop-early baseline. They spend 15 minutes hunting reward exploits.

**Harness:** the team's choice. The booth recommended **Harbor + OpenCode**.
- A Harbor task folder holds: `task.toml`, `instruction.md`, `environment/Dockerfile`, `tests/test.sh` (which writes a float to `/logs/verifier/reward.txt`, or named scores to `reward.json`), and an optional `solution/`.
- OpenCode is a coding agent with shell access, so it can read anything in its container and write its own solvers.

## Design principles we settled on

1. **Keep the simulator, hidden state and seeds outside the agent's container.** Expose them as a service (MCP/HTTP), and score from the server-side ledger.
2. **Fully specified optimisation collapses.** A coding agent writes a solver for it. The gap has to come from:
   - hidden state discovered through costly interaction
   - silent changes in the world
   - long-horizon commitments
   - consistency across runs
3. **The reference sees exactly what the agent sees.** No hindsight oracle as the reference; use the oracle only as an upper bound.
4. **Copy StoreBench (AfterQuery's own environment, Nov 2026).** Its conventions:
   - seeded, with no LLM inside the world
   - time measured in tool calls (operations)
   - events announced, rumoured or silent
   - a ladder of scripted policies: do-nothing, absentee, exploiter, naive, rule-based, smart; these set each task's scale and pass threshold
   - settlement before scoring
   - composite score: 0.7 business + 0.2 reliability + 0.1 continuity
5. **Evidence on where agents fail:**
   - long-horizon finishing and checking their own work (Long-Horizon-Terminal-Bench, Agents' Last Exam)
   - noticing and acting on silent change (STOCKTAKE, StoreBench slow-drift)
   - reliability: METR 50% vs 80% time horizons
   - ignoring orders in transit (Beer Game papers)
   - poor in-context exploration (Krishnamurthy et al. 2024)

## Idea: Hackathon Logistics ("48 Hours")

The agent runs a hackathon's supply chain from about four months out through the 48-hour event. The pitch draws on a team member's real experience running hackathons.

- **Task:** order branded merch, meet sponsor deliverables, book the venue (plus an optional refundable backup hold), pre-order catering, then run food and drink hour by hour.
- **Information:**
  - Visible: stock, orders in transit, budget, registrations, a news and announcement feed.
  - Hidden: the shipping-disruption regime (calm / tense / disrupted, e.g. Iran-war routes; trade press reported promo-merch lead times of 30 → ~75 days), the no-show rate, and emergencies such as a venue leak the day before.
- **Actions:**
  - `place_order` with a choice of supplier: China (slow, cheap), EU (fast), air freight (fastest)
  - hold or release a venue
  - `book_catering`
  - `end_window`
  - Each call spends from a per-window operation budget.
- **Dynamics:** one clock in three phases: daily planning, the final week, then 48 hourly event steps. Orders and deposits are commitments, food spoils, and shocks arrive mid-episode.
- **Reward:** settled ledger: spend, waste, sponsor penalties for missing logos, hungry hacker-hours, ceremony delay.
- **Levels:**
  - L1: food only
  - L2: + long-lead merch
  - L3: + disruption headlines
  - L4: + emergencies and insurance decisions
- **Reference:**
  - count stock already in transit
  - order at a high percentile of lead time, given a Bayesian estimate of the disruption regime from headlines
  - hold the backup venue when P(loss) × cost > fee
  - pre-order catering when its savings beat the expected waste

## Idea: GPU World

Same supply-chain simulator as Hackathon Logistics, different domain. The agent is compute procurement lead at an AI lab.

- **Task:** hit training milestones (GPU-weeks by each deadline) and serve variable inference demand at the lowest total cost.
- **Information:**
  - Visible: owned GPUs, contracts, orders in transit, spot and contract prices, power capacity, news.
  - Hidden: CoWoS packaging and HBM capacity, the export-control regime, competitor demand, and the next GPU generation's launch date.
  - Real anchors:
    - lead times of about 36–52 weeks
    - H100 one-year contract price fell $6.62 → $2.83 per hour (late 2023 → Feb 2026), then rose 38% (Oct 2025 → Mar 2026)
    - grid connections take 1–3+ years
- **Actions:** `buy_gpus` (long lead time, delivery allocated rather than guaranteed), `reserve_capacity` (1–3 year contracts), `rent_spot`, `contract_power` or `build_site`, `resell_gpus` (at a discount), `end_window`.
- **Dynamics:** weekly steps over about 2 years. Prices move both ways, the binding constraint shifts between GPUs, power and contracts, and each new generation cuts resale value.
- **Reward:** settled ledger with owned GPUs marked to market and remaining contract obligations charged. The score combines milestones met with net cost.
  - Guard against buy-and-resell arbitrage with resale discounts, transaction costs and capacity limits, and add an exploiter policy that tests for it.
- **Reference:** Bayesian estimate of the regime plus expected-cost hedging; the oracle is an upper bound only.

## Experiment protocol, run for the concurrency idea and reusable here

The code is in `experiments/relax-fences/`:
- `relax.py`: tasks, checker, search
- `reference.py`: optimum and greedy references
- `run_agent.py`: one isolated agent attempt
- `run_all.py`: the batch

1. Write the task generator and a deterministic scorer, and sanity-check the scorer on cases with known answers.
2. Compute the reference policies and the optimum, or an upper bound, offline.
3. Run the frontier agent headless and isolated. Each run is scored the same way afterwards:
   ```
   claude -p "<prompt>" --output-format json --setting-sources local --strict-mcp-config \
     --no-session-persistence --max-turns 80 --allowedTools Read Write Edit "Bash(python check.py)" \
     --disallowedTools WebSearch WebFetch Task Agent
   ```
   This ran on `claude-opus-5-5`. OpenCode needs an API key, which this machine doesn't have.
4. Compare the agent against the reference at the same budget, over 2 or more attempts per condition.

**Go / no-go rule:** go if the reference beats the agent on most seeds and the agent beats the naive baselines. Kill or rework if the agent reaches about 90% or more of the reference.

**Practical:**
- Docker Desktop must be running.
- Use one persistent checker container with `docker exec` (~0.3 s per check), not `docker run` per check (2–3 s).
