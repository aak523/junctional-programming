# Training a small open model on GPU World experience

Stretch goal from CHALLENGE.md: train a smaller model using experience from the environment and show whether it improves.
We fine-tune `Qwen/Qwen3-4B-Instruct-2507` with LoRA (r 32, all linear layers):

1. **Behaviour cloning (SFT).** The Bayesian-LP reference (`policies.LPPolicy`) plays 400 training worlds (seeds
   10000-10399, 9,600 months). Every month becomes one example: the rules as the system prompt, the month's screen plus
   a table of finished months and recent notes as the user message, and the reference's commands as the reply. The
   reply starts with a belief note synthesised from the reference's posterior (P(tight), launch month, export controls,
   broker reliability, inference growth, what the current training window still needs, plan). SFT uses a random 4,800
   of the 9,600 months for one epoch.
2. **DAgger round 2: relabels + reward selection.** The SFT model plays 60 new worlds (seeds 11000-11059) 6 times each
   at temperature 0.8. The reference relabels every state of 2 student episodes per world (the best and the worst),
   which corrects compounding errors. The student's own best episode per world is also kept when it beats its greedy
   play there, so environment reward enters training; plus a 10% replay of the teacher data. Training continues from
   the SFT adapter.
3. **DAgger aggregate (round 3).** Round 2 regressed (see Results), so, as planned for that case, training continues
   from the SFT adapter on the textbook DAgger aggregate instead: the 4,800 teacher months SFT did not see plus every
   relabelled state, with no self-imitation.

Evaluation: greedy decoding, one episode per held-out seed, on seeds 0-9 (the README ladder) and 20000-20019. Training
seeds never overlap evaluation seeds or the LP-tuning seeds (100+). Reward is the Harbor verifier's: oracle net cost /
net cost, capped at 1.

## Interface

The model plays the "direct monthly policy" format (`llm_env.py`): one message per month, one line of `;`-separated
commands back, `end_month` always appended. Commands run through `service.execute`, the same code path the Harbor world
server uses, and the reward comes from the world's own settlement. The model never sees the seed or any hidden state:
the user message is built from the rendered screen, the finished-month table and the model's own notes only.

## Files

| file | role |
|---|---|
| `llm_env.py` | system prompt (TASK.md + reply rules), user message, reply parser, `Episode` |
| `gen_sft.py` | reference episodes -> JSONL; `--verify` replays them through `Episode.step` |
| `rollout.py` | batched vLLM play, one chat call per month for all episodes |
| `eval_llm.py` | held-out evaluation of a model or a scripted policy -> `results/<name>.json` |
| `relabel.py` | DAgger labels for the student's states; `--check` reproduces reference episodes exactly |
| `select_round2.py` | round-2 dataset: relabelled states + kept student episodes + replay |
| `aggregate.py` | round-3 dataset: unseen teacher months + relabelled states |
| `rescore.py` | re-score results against the current checkout's oracle |
| `sft.py` | TRL `SFTTrainer` + LoRA (r 32), loss on the reply only; `--init-adapter`, `--merge-out` |
| `report.py` | `results/REPORT.md` and `results/rewards.png` |
| `test_env.py` | parser and wrapper checks |
| `cloud/box.py` | Verda GPU box: `status`, `up`, `down` |
| `cloud/startup.sh`, `cloud/run_box.sh`, `cloud/sync_down.sh` | box setup, one pipeline stage per call, copy results back |

## Checks that passed before any training

- `test_env.py`: code fences, text after `end_month`, a missing `end_month`, `;` inside a note, free commands and garbage
  all behave as in Harbor.
- `gen_sft.py --verify`: replaying every stored reply through `Episode.step` reproduces the stored prompts and the
  reference's exact net cost, and equals `policies.play(LPPolicy, seed)`.
- `relabel.py --check`: relabelling the reference's own episodes reproduces every reply exactly.
- `eval_llm.py --model scripted:*` reproduces `results/ladder.json`.
- `sft.py` checks that the trained tokens of the first batch are exactly the assistant reply.

## Reproduce

```bash
python train/cloud/box.py up                      # Verda credentials from the environment or .env
ssh root@<ip> 'cat /root/SETUP_DONE'              # setup takes ~15 min
# on the box, in /root/jp, one stage at a time:
bash train/cloud/run_box.sh gen        # 400 reference episodes + verify
bash train/cloud/run_box.sh baselines  # do_nothing, oracle, reference on the eval seeds
bash train/cloud/run_box.sh base       # the untrained model
bash train/cloud/run_box.sh sft        # SFT, merge, eval
bash train/cloud/run_box.sh sample; bash train/cloud/run_box.sh relabel; bash train/cloud/run_box.sh round2
bash train/cloud/run_box.sh round3     # unseen teacher months + relabels, continued from SFT
python train/rescore.py base sft dagger dagger3   # if the oracle changes, re-score (net costs do not change)
# locally:
bash train/cloud/sync_down.sh && python train/report.py && python train/cloud/box.py down
```

## Results

Full tables (both seed sets, error rates, the round-2 statistics): `results/REPORT.md`. Per-seed rewards: `results/rewards.png`.

Mean reward on the 30 held-out worlds (seeds 0-9 and 20000-20019), greedy, against the oracle after the options fix:

| policy | seeds 0-9 | seeds 20000-20019 | worlds with all 3 runs met | commands rejected |
|---|---|---|---|---|
| do nothing | 0.214 | 0.215 | 0 / 30 | - |
| Qwen3-4B-Instruct-2507, untrained | 0.246 | 0.250 | 1 / 30 | 46% |
| SFT on 4,800 teacher months | 0.497 | 0.445 | 5 / 30 | 1.1% |
| + DAgger round 2 (relabels + own best episodes + 10% replay) | 0.417 | 0.406 | 18 / 30 | 1.6% |
| **+ DAgger aggregate (the 4,800 unseen teacher months + 2,814 relabels)** | **0.583** | **0.573** | 12 / 30 | 1.2% |
| teacher: the reference before the options fix (466fcc7) | 0.877 | 0.862 | 30 / 30 | 0% |
| current reference | 0.922 | 0.920 | 30 / 30 | 0% |

What the numbers say:
- **Training works, and DAgger adds to SFT.** The aggregate round is 2.3x the untrained model's reward and beats SFT
  on both seed sets; mean net cost falls from $2,980M (untrained) to $1,716M (SFT) to $1,319M.
- **Self-imitation hurt.** Round 2 kept the student's own best-of-6 episodes when they beat its greedy play (51 of 60
  worlds). It cut missed runs from 52 to 13 but more than doubled reserved-capacity spend ($596M to $1,334M against
  the reference's $615M), so reward fell. Dropping those episodes and training on unseen teacher data plus relabels
  (textbook DAgger) fixed it.
- **What the model still gets wrong.** It misses 22 of 90 training runs (13 of them the first window, months 0-7) and
  rents too much: $836M of reservations and $184M of contracts running past month 23, against the reference's $615M
  and $91M. Penalties ($171M per world) and over-leasing make up most of the gap to the teacher ($1,319M vs $830M).
- **The relabeller found states the expert cannot plan for.** 6 of 2,820 student states had no feasible LP plan
  (debt beyond the credit line); they are skipped.

Compute: one Verda A100 80GB (no H100 was free on demand), about 8 GPU-hours. Throughput: batch 1 x accumulation 16,
no activation checkpointing and the Liger fused loss gave 6.1k tokens/s, 3.2x the defaults; a month's example is
about 5.2k tokens (2.8k of them the rules), so each SFT round used about 4,800 examples (70 minutes).
