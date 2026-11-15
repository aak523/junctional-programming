#!/bin/bash
# Follow-up experiments on a multi-GPU box, one per tmux session, pinned with GPUS (e.g. GPUS=0,1,2).
# usage: GPUS=3 bash train/cloud/exp.sh <name>     log: train/logs/exp_<name>.log, ends with STAGE_OK / STAGE_FAILED
# names: teacher sft_rep short short_full qwen8b dagger4 dpo
set -o pipefail
cd "$(dirname "$0")/../.."
. /root/venv/bin/activate
export HF_HUB_ENABLE_HF_TRANSFER=1 TOKENIZERS_PARALLELISM=false CUDA_VISIBLE_DEVICES=${GPUS:-0}
N=$(echo "$CUDA_VISIBLE_DEVICES" | tr ',' '\n' | wc -l)
EVAL="--seeds 0 10 --seeds 20000 20020"
P=${PROCS:-24}
mkdir -p train/logs train/data train/ckpt train/results
sft() { if [ "$N" -gt 1 ]; then torchrun --nproc_per_node $N --master_port $((29500 + RANDOM % 1000)) train/sft.py --accum $((16 / N)) "$@";
        else python train/sft.py "$@"; fi; }
wait_for() { until grep -q "^STAGE_OK" train/logs/exp_$1.log 2>/dev/null; do
               grep -q "^STAGE_FAILED" train/logs/exp_$1.log 2>/dev/null && return 1; sleep 30; done; }
name=$1
run() {
  case $name in
    teacher)  # the reference these models learned from (policies.py of 2303cc6), regenerated: deterministic
              python train/gen_sft.py --seeds 10000 10400 --procs $P --out train/data/sft_ref.jsonl &&
              python train/gen_sft.py --verify train/data/sft_ref.jsonl --against-play 1 ;;
    sft_rep)  # same recipe as the first SFT, a different random 4,800 months: run-to-run variance
              wait_for teacher && sft --data train/data/sft_ref.jsonl --limit 4800 --shuffle-seed 1 --liger \
                --out train/ckpt/sft_rep --merge-out train/ckpt/sft_rep-merged &&
              python train/eval_llm.py --model train/ckpt/sft_rep-merged $EVAL --name sft_rep ;;
    short)    # the first SFT with the rules cut to the task statement (45% fewer tokens per example)
              export GPUW_PROMPT=short
              wait_for teacher && sft --data train/data/sft_ref.jsonl --limit 4800 --liger \
                --out train/ckpt/sft_short --merge-out train/ckpt/sft_short-merged &&
              python train/eval_llm.py --model train/ckpt/sft_short-merged $EVAL --name sft_short ;;
    short_full) # short prompt, all 9,600 teacher months
              export GPUW_PROMPT=short
              wait_for teacher && sft --data train/data/sft_ref.jsonl --limit 9600 --liger \
                --out train/ckpt/sft_short_full --merge-out train/ckpt/sft_short_full-merged &&
              python train/eval_llm.py --model train/ckpt/sft_short_full-merged $EVAL --name sft_short_full ;;
    qwen8b)   # the first SFT on Qwen3-8B (thinking off)
              wait_for teacher && sft --base Qwen/Qwen3-8B --data train/data/sft_ref.jsonl --limit 4800 --liger \
                --out train/ckpt/sft_8b --merge-out train/ckpt/sft_8b-merged &&
              python train/eval_llm.py --model train/ckpt/sft_8b-merged $EVAL --name sft_8b ;;
    dagger4)  # another DAgger round from the best model: its own states relabelled + 20% teacher replay
              python train/merge.py train/ckpt/dagger3 train/ckpt/dagger3-merged &&
              python train/rollout.py --model train/ckpt/dagger3-merged --seeds 11060 11160 --k 6 --temperature 0.8 \
                --policy dagger3_student --procs $P --out train/data/samples4.jsonl &&
              python train/rollout.py --model train/ckpt/dagger3-merged --seeds 11060 11160 --k 1 --temperature 0 \
                --policy dagger3_student --procs $P --out train/data/greedy4.jsonl &&
              python train/relabel.py train/data/samples4.jsonl --per-seed 3 --procs $P --out train/data/relabel4.jsonl &&
              wait_for teacher &&
              python train/select_round2.py --samples train/data/samples4.jsonl --greedy train/data/greedy4.jsonl \
                --relabel train/data/relabel4.jsonl --sft train/data/sft_ref.jsonl --replay 0.2 --no-keep-student \
                --out train/data/round4.jsonl --stats train/results/round4_stats.json &&
              sft --data train/data/round4.jsonl --init-adapter train/ckpt/dagger3 --lr 5e-5 --liger \
                --out train/ckpt/dagger4 --merge-out train/ckpt/dagger4-merged &&
              python train/eval_llm.py --model train/ckpt/dagger4-merged $EVAL --name dagger4 ;;
    dpo)      # the reference's reply preferred over the student's own, in the student's states (pairs from dagger4)
              until [ -s train/data/relabel4.jsonl ] && grep -q "relabelled" train/logs/exp_dagger4.log; do sleep 30; done
              if [ "$N" -gt 1 ]; then L="torchrun --nproc_per_node $N --master_port $((30500 + RANDOM % 1000))"; else L=python; fi
              $L train/dpo.py --samples train/data/samples4.jsonl --relabel train/data/relabel4.jsonl \
                --model train/ckpt/dagger3-merged --out train/ckpt/dpo --merge-out train/ckpt/dpo-merged &&
              python train/eval_llm.py --model train/ckpt/dpo-merged $EVAL --name dpo ;;
    *)        echo "unknown experiment $name"; return 1 ;;
  esac
}
{ date; run && echo STAGE_OK || echo STAGE_FAILED; date; } 2>&1 | tee train/logs/exp_$name.log
