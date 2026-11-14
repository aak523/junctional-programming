#!/bin/bash
# One pipeline stage on the box, logged to train/logs/<stage>.log; prints STAGE_OK / STAGE_FAILED at the end.
# usage (on the box, in /root/jp, inside tmux): bash train/cloud/run_box.sh <stage>
# stages: gen baselines base_smoke base mask sft sample relabel round2
set -o pipefail
cd /root/jp
. /root/venv/bin/activate
export HF_HUB_ENABLE_HF_TRANSFER=1 TOKENIZERS_PARALLELISM=false
BASE=Qwen/Qwen3-4B-Instruct-2507
EVAL="--seeds 0 10 --seeds 20000 20020"
P=$(( $(nproc) - 2 ))
# A100 measurements: batch 1 x accum 16, no activation checkpointing, Liger fused loss = 6.1k tok/s (3.2x the defaults);
# an example is ~5.2k tokens, so SFT uses a random 4,800 of the 9,600 teacher examples (~70 min)
SFT_LIMIT=${SFT_LIMIT:-4800}
mkdir -p train/logs train/data train/ckpt train/results
stage=$1
run() {
  case $stage in
    gen)        python train/gen_sft.py --seeds 10000 10400 --procs $P --out train/data/sft_ref.jsonl &&
                python train/gen_sft.py --verify train/data/sft_ref.jsonl --against-play 1 ;;
    baselines)  for m in do_nothing oracle reference; do
                  python train/eval_llm.py --model scripted:$m $EVAL --name $m --procs $P || return 1; done ;;
    base_smoke) python train/eval_llm.py --model $BASE --seeds 0 2 --name smoke_base ;;
    base)       python train/eval_llm.py --model $BASE $EVAL --name base ;;
    mask)       python train/sft.py --data train/data/sft_ref.jsonl --limit 320 --max-steps 20 --liger --out train/ckpt/mask ;;
    sft)        python train/sft.py --data train/data/sft_ref.jsonl --limit $SFT_LIMIT --liger --out train/ckpt/sft --merge-out train/ckpt/sft-merged &&
                python train/eval_llm.py --model train/ckpt/sft-merged $EVAL --name sft ;;
    sample)     python train/rollout.py --model train/ckpt/sft-merged --seeds 11000 11100 --k 6 --temperature 0.8 \
                  --out train/data/dagger_samples.jsonl &&
                python train/rollout.py --model train/ckpt/sft-merged --seeds 11000 11100 --k 1 --temperature 0 \
                  --out train/data/dagger_greedy.jsonl ;;
    relabel)    python train/relabel.py train/data/dagger_samples.jsonl --per-seed 4 --procs $P --out train/data/dagger_relabel.jsonl &&
                python train/select_round2.py --samples train/data/dagger_samples.jsonl --greedy train/data/dagger_greedy.jsonl \
                  --relabel train/data/dagger_relabel.jsonl --sft train/data/sft_ref.jsonl --replay ${REPLAY:-0.2} \
                  --out train/data/round2.jsonl --stats train/results/round2_stats.json ;;
    round2)     python train/sft.py --data train/data/round2.jsonl --init-adapter train/ckpt/sft --lr 5e-5 --liger --out train/ckpt/dagger \
                  --merge-out train/ckpt/dagger-merged &&
                python train/eval_llm.py --model train/ckpt/dagger-merged $EVAL --name dagger ;;
    *)          echo "unknown stage $stage"; return 1 ;;
  esac
}
{ date; run && echo STAGE_OK || echo STAGE_FAILED; date; } 2>&1 | tee train/logs/$stage.log
