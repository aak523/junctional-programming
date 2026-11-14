# Training a small open model on GPU World experience

Stretch goal from CHALLENGE.md: train a smaller model using experience from the environment and show whether it improves.
We fine-tune `Qwen/Qwen3-4B-Instruct-2507` with LoRA, in two stages:

1. **Behaviour cloning (SFT).** The Bayesian-LP reference (`policies.LPPolicy`) plays 400 training worlds (seeds
   10000-10399). Every month becomes one example: the rules as the system prompt, the month's screen plus a table of
   finished months and recent notes as the user message, and the reference's commands as the reply. The reply starts
   with a belief note synthesised from the reference's posterior (P(tight), launch month, export controls, broker
   reliability, inference growth, what the current training window still needs, plan).
2. **DAgger + reward selection.** The SFT model plays 100 new worlds (seeds 11000-11099) 6 times each at temperature
   0.8. The reference relabels every state the student actually reached, which corrects compounding errors. The
   student's own best episode per seed is also kept when it beats its greedy play on that seed, so environment reward
   enters training. The adapter is then trained further on that data plus a 20% replay of the SFT data.

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
# locally:
bash train/cloud/sync_down.sh && python train/report.py && python train/cloud/box.py down
```

## Results

See `results/REPORT.md` and `results/rewards.png`.
