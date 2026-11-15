#!/bin/bash
# Deadline-sized second half of the DAgger round 4 and DPO experiments (replaces exp.sh dagger4/dpo after sampling):
# relabel 2 student episodes per world, no greedy pass (round 4 keeps no student episodes), round-4 SFT on GPUs 5,6
# and DPO on GPUs 1,2 in parallel. usage (box, in the checkout, inside tmux): bash train/cloud/phase2.sh
cd "$(dirname "$0")/../.."
. /root/venv/bin/activate
export TOKENIZERS_PARALLELISM=false
EVAL="--seeds 0 10 --seeds 20000 20020"
until grep -q "episodes, mean reward" train/logs/exp_dagger4.log; do sleep 15; done
tmux kill-session -t dagger4
log=train/logs/exp_dagger4b.log
{
  date
  python train/relabel.py train/data/samples4.jsonl --per-seed 2 --procs 150 --out train/data/relabel4.jsonl &&
  python train/select_round2.py --samples train/data/samples4.jsonl --greedy train/data/samples4.jsonl \
    --relabel train/data/relabel4.jsonl --sft train/data/sft_ref.jsonl --replay 0.2 --no-keep-student \
    --out train/data/round4.jsonl --stats train/results/round4_stats.json || { echo STAGE_FAILED; exit 1; }
  (CUDA_VISIBLE_DEVICES=1,2 torchrun --nproc_per_node 2 --master_port 30777 train/dpo.py --samples train/data/samples4.jsonl \
     --relabel train/data/relabel4.jsonl --model train/ckpt/dagger3-merged --max-pairs 1200 --out train/ckpt/dpo \
     --merge-out train/ckpt/dpo-merged &&
   CUDA_VISIBLE_DEVICES=1 python train/eval_llm.py --model train/ckpt/dpo-merged $EVAL --name dpo &&
   echo STAGE_OK || echo STAGE_FAILED) > train/logs/exp_dpo.log 2>&1 &
  CUDA_VISIBLE_DEVICES=5,6 torchrun --nproc_per_node 2 --master_port 30555 train/sft.py --data train/data/round4.jsonl \
    --init-adapter train/ckpt/dagger3 --accum 8 --lr 5e-5 --liger --out train/ckpt/dagger4 --merge-out train/ckpt/dagger4-merged &&
  CUDA_VISIBLE_DEVICES=5 python train/eval_llm.py --model train/ckpt/dagger4-merged $EVAL --name dagger4 &&
  echo STAGE_OK || echo STAGE_FAILED
  wait
  date
} 2>&1 | tee $log
