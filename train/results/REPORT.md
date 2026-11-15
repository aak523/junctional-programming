# Fine-tuning results

World v5 rules (commit 2303cc6; world.py, lp.py, TASK.md and service.py unchanged since). Rewards use the oracle of commit 1bffa9f, 5403623, a75ac70 (after the options fix in 466fcc7). Greedy decoding, one episode per held-out seed; reward = oracle net cost / net cost, capped at 1 (the Harbor verifier's formula).

## Seeds 0-9

| policy | mean reward | mean net cost ($M) | all 3 runs met | command error rate | forced ends |
|---|---|---|---|---|---|
| do nothing (scripted) | 0.214 | 3401 | 0/10 | 0.0% | 0 |
| Qwen3-4B-Instruct, untrained | 0.246 | 3064 | 1/10 | 48.3% | 8 |
| SFT on 4,800 teacher months | 0.497 | 1613 | 2/10 | 1.8% | 0 |
| SFT repeat, another 4,800 months | 0.378 | 2001 | 0/10 | 0.7% | 0 |
| SFT, short system prompt | 0.475 | 1749 | 3/10 | 0.7% | 0 |
| SFT, short prompt, all 9,600 months | 0.461 | 1772 | 1/10 | 1.0% | 0 |
| SFT on Qwen3-8B (thinking off) | 0.392 | 2005 | 0/10 | 0.8% | 0 |
| + DAgger round 2 (relabels + own best episodes) | 0.417 | 1768 | 6/10 | 1.4% | 0 |
| + DAgger aggregate (unseen teacher + relabels) | 0.583 | 1318 | 4/10 | 1.4% | 0 |
| + DAgger round 4 (its own states relabelled) | 0.624 | 1222 | 6/10 | 1.3% | 0 |
| DAgger aggregate + DPO (reference over own reply) | 0.380 | 2043 | 8/10 | 15.6% | 7 |
| SFT on 4,800 months of the current reference | 0.372 | 1991 | 1/10 | 0.7% | 0 |
| teacher: the reference before the options fix | 0.877 | 832 | 10/10 | 0.0% | 0 |
| current Bayesian-LP reference | 0.922 | 790 | 10/10 | 0.0% | 0 |
| perfect-information oracle | 1.000 | 734 | 10/10 | 0.0% | 0 |

## Seeds 20000-20019

| policy | mean reward | mean net cost ($M) | all 3 runs met | command error rate | forced ends |
|---|---|---|---|---|---|
| do nothing (scripted) | 0.215 | 3310 | 0/20 | 0.0% | 0 |
| Qwen3-4B-Instruct, untrained | 0.249 | 2940 | 0/20 | 45.0% | 24 |
| SFT on 4,800 teacher months | 0.445 | 1767 | 3/20 | 0.7% | 0 |
| SFT repeat, another 4,800 months | 0.401 | 1828 | 1/20 | 0.8% | 0 |
| SFT, short system prompt | 0.387 | 1881 | 0/20 | 0.8% | 0 |
| SFT, short prompt, all 9,600 months | 0.443 | 1725 | 2/20 | 0.4% | 0 |
| SFT on Qwen3-8B (thinking off) | 0.348 | 2094 | 0/20 | 0.7% | 0 |
| + DAgger round 2 (relabels + own best episodes) | 0.406 | 1779 | 12/20 | 1.8% | 0 |
| + DAgger aggregate (unseen teacher + relabels) | 0.573 | 1319 | 8/20 | 1.1% | 0 |
| + DAgger round 4 (its own states relabelled) | 0.634 | 1150 | 15/20 | 1.3% | 0 |
| DAgger aggregate + DPO (reference over own reply) | 0.401 | 1832 | 15/20 | 13.1% | 9 |
| SFT on 4,800 months of the current reference | 0.374 | 1936 | 0/20 | 0.5% | 0 |
| teacher: the reference before the options fix | 0.862 | 828 | 20/20 | 0.0% | 0 |
| current Bayesian-LP reference | 0.920 | 772 | 20/20 | 0.0% | 0 |
| perfect-information oracle | 1.000 | 714 | 20/20 | 0.0% | 0 |

## DAgger round

```
{
 "relabelled_states": 2814,
 "kept_episodes": 51,
 "kept_states": 1224,
 "replay_states": 960,
 "total": 4998,
 "seeds": 60,
 "mean_reward_greedy": 0.458,
 "mean_reward_samples": 0.4904,
 "mean_reward_best_of_k": 0.6299,
 "mean_reward_kept": 0.641
}
```
