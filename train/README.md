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
4. **DAgger round 4.** The round-3 model plays 100 new worlds (seeds 11060-11159) 6 times each; the reference relabels
   2 of its episodes per world (4,698 states), and training continues from the round-3 adapter on those plus a 20%
   replay of the teacher data.
5. **DPO (preference training).** In the same round-4 states, the reference's reply is preferred over the round-3
   model's own reply (1,200 pairs where they differ); a new LoRA is trained on the merged round-3 model.

Follow-up SFT variants test the recipe: another random half of the teacher data (run-to-run variance), a short system
prompt, all the teacher data, Qwen3-8B, and teacher data from the reference after its options fix.

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
| `merge.py`, `dpo.py` | merge a LoRA into its base; DPO on (reference reply, student reply) pairs |
| `cloud/exp.sh`, `cloud/phase2.sh` | the follow-up experiments, one per GPU group on a multi-GPU box |
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
# follow-ups on a multi-GPU box, in a checkout with policies.py from 2303cc6 (the teacher these models learned from):
GPUS=3 bash train/cloud/exp.sh sft_rep    # also: short, short_full, qwen8b (GPUS=0,1,2), teacher first
bash train/cloud/phase2.sh                # DAgger round 4 + DPO, after exp.sh dagger4 has sampled
# locally:
bash train/cloud/sync_down.sh && python train/report.py && python train/cloud/box.py down
```

## Results

Full tables (both seed sets, error rates, round statistics): `results/REPORT.md`. Per-seed rewards: `results/rewards.png`.

Mean reward on the 30 held-out worlds (seeds 0-9 and 20000-20019), greedy, against the oracle after the options fix:

| policy | seeds 0-9 | seeds 20000-20019 | worlds with all 3 runs met | commands rejected |
|---|---|---|---|---|
| do nothing | 0.214 | 0.215 | 0 / 30 | - |
| Qwen3-4B-Instruct-2507, untrained | 0.246 | 0.250 | 1 / 30 | 46% |
| SFT on 4,800 teacher months | 0.497 | 0.445 | 5 / 30 | 1.1% |
| + DAgger round 2 (relabels + own best episodes + 10% replay) | 0.417 | 0.406 | 18 / 30 | 1.6% |
| + DAgger aggregate, round 3 (the 4,800 unseen teacher months + 2,814 relabels) | 0.583 | 0.573 | 12 / 30 | 1.2% |
| **+ DAgger round 4 (4,698 of its own states relabelled + 20% teacher replay)** | **0.624** | **0.634** | **21 / 30** | 1.3% |
| round 3 + DPO (1,200 pairs: the reference's reply preferred over its own) | 0.380 | 0.401 | 23 / 30 | 13.9% |
| teacher: the reference before the options fix (466fcc7) | 0.877 | 0.862 | 30 / 30 | 0% |
| current reference | 0.922 | 0.920 | 30 / 30 | 0% |

Follow-up SFT variants (same 30 worlds; compare with the first SFT, 0.462 over the 30 worlds):

| variant | seeds 0-9 | seeds 20000-20019 | 30-world mean | missed runs (of 90) |
|---|---|---|---|---|
| first SFT (4,800 months, seed 0 subset) | 0.497 | 0.445 | 0.462 | 52 |
| same recipe, another random 4,800 months | 0.378 | 0.401 | 0.393 | 72 |
| short system prompt (task statement + reply rules, 45% fewer tokens) | 0.475 | 0.387 | 0.416 | 60 |
| short prompt, all 9,600 months | 0.461 | 0.443 | 0.449 | 63 |
| Qwen3-8B (thinking off), same 4,800 months | 0.392 | 0.348 | 0.363 | 68 |
| 4,800 months of the current (fixed) reference | 0.372 | 0.375 | 0.374 | 63 |

What the numbers say:
- **Training works, and each DAgger round adds to it.** Untrained 0.25, SFT 0.46, round 3 0.58, round 4 0.63 (30-world
  means). Round 3 beats SFT by 0.114 reward (standard error 0.025, better on 23 of 30 worlds); round 4 beats round 3 by
  0.055 (standard error 0.024, better on 19 of 30). Mean net cost falls from $2,980M untrained to $1,716M (SFT), $1,319M
  (round 3) and $1,174M (round 4); the teacher's is $830M.
- **DAgger is where the gain is; SFT variants are within noise.** Two SFT runs with the same recipe on different random
  halves of the teacher data differ by 0.07 (0.46 vs 0.39). Against that spread, the short prompt, twice the data, the
  fixed reference as teacher and Qwen3-8B are no better than the first SFT. The short prompt trains 2.6x faster for a
  similar result, so it is the cheaper setting for future rounds. The 8B model is the hybrid-thinking Qwen3-8B, not an
  instruct-2507 model, and got one epoch at the 4B learning rate; it is not evidence that size does not help.
- **DPO overshot.** Preferring the reference's reply over the round-3 model's own, in the model's own states, met more
  training runs (23 of 30 worlds) but made 14% of its commands invalid and overspent: mean net cost $1,902M against
  round 3's $1,319M (worse on 29 of 30 worlds). Pushing away from its own replies took it off its output distribution;
  a smaller beta, fewer steps or an SFT term would be the next things to try.
- **Self-imitation hurt.** Round 2 kept the student's own best-of-6 episodes when they beat its greedy play (51 of 60
  worlds). It cut missed runs from 52 to 13 but more than doubled reserved-capacity spend ($596M to $1,334M against
  the reference's $615M), so reward fell. Relabels plus teacher data only (rounds 3 and 4) fixed it.
- **What the best model still gets wrong.** Round 4 misses 10 of 90 training runs (it fixed the first window: 3 misses,
  down from 13) and still rents too much: $775M of reservations and $162M of contracts running past month 23, against
  the reference's $615M and $91M, plus $82M of penalties per world.
- **The relabeller found states the expert cannot plan for.** 6 of about 7,500 student states had no feasible LP plan
  (debt beyond the credit line); they are skipped.

Adapters (LoRA, 264 MB each, too large for git) are kept outside the repository under `ckpt/`: `dagger4` (the trained
model), `dagger3`, `sft` and `sft_v2`, loadable with `PeftModel.from_pretrained` on the base model. `requirements.txt`
is the box's frozen environment.

Compute: a Verda A100 80GB for the main line (no H100 was free on demand, about 7 GPU-hours) and an 8x RTX PRO 6000
box for the follow-ups (about 2 hours, run in parallel with `cloud/exp.sh` and `cloud/phase2.sh`). Total cost $63.17 ($17.90 A100, $45.27 the 8-GPU box).
Throughput on the A100: batch 1 x accumulation 16, no activation checkpointing and the Liger fused loss gave 6.1k
tokens/s, 3.2x the defaults; a month's example is about 5.2k tokens (2.8k of them the rules), so each SFT round used
about 4,800 examples (70 minutes).
