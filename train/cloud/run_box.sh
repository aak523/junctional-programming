#!/bin/bash
# One pipeline stage on the box, logged to train/logs/<stage>.log; prints STAGE_OK / STAGE_FAILED at the end.
# usage (on the box, in /root/jp, inside tmux): bash train/cloud/run_box.sh <stage>
# stages: gen baselines base_smoke base mask sft sft_full sample relabel round2 round3
set -o pipefail
cd "$(dirname "$0")/../.."   # the checkout this script lives in
. /root/venv/bin/activate
export HF_HUB_ENABLE_HF_TRANSFER=1 TOKENIZERS_PARALLELISM=false
BASE=Qwen/Qwen3-4B-Instruct-2507
EVAL="--seeds 0 10 --seeds 20000 20020"
P=${PROCS:-$(( $(nproc) - 2 ))}
# A100 measurements: batch 1 x accum 16, no activation checkpointing, Liger fused loss = 6.1k tok/s (3.2x the defaults);
# an example is ~5.2k tokens, so SFT uses a random 4,800 of the 9,600 teacher examples (~70 min)
SFT_LIMIT=${SFT_LIMIT:-4800}
# round 2 sized to the same ~70 min: 60 seeds x 6 samples, 2 relabelled episodes per seed, 10% replay of the teacher data
DAGGER_SEEDS="11000 ${DAGGER_END:-11060}"
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
    sft_full)   # every teacher example, 2 epochs, data parallel over all GPUs on the box
                n=$(nvidia-smi -L | wc -l)
                torchrun --nproc_per_node $n train/sft.py --data train/data/sft_ref.jsonl --epochs 2 --accum $(( 16 / n > 0 ? 16 / n : 1 ))                   --liger --out train/ckpt/sft_full --merge-out train/ckpt/sft_full-merged &&
                python train/eval_llm.py --model train/ckpt/sft_full-merged $EVAL --name sft_full ;;
    sample)     python train/rollout.py --model train/ckpt/sft-merged --seeds $DAGGER_SEEDS --k 6 --temperature 0.8 \
                  --out train/data/dagger_samples.jsonl &&
                python train/rollout.py --model train/ckpt/sft-merged --seeds $DAGGER_SEEDS --k 1 --temperature 0 \
                  --out train/data/dagger_greedy.jsonl ;;
    relabel)    python train/relabel.py train/data/dagger_samples.jsonl --per-seed ${PER_SEED:-2} --procs $P --out train/data/dagger_relabel.jsonl &&
                python train/select_round2.py --samples train/data/dagger_samples.jsonl --greedy train/data/dagger_greedy.jsonl \
                  --relabel train/data/dagger_relabel.jsonl --sft train/data/sft_ref.jsonl --replay ${REPLAY:-0.1} \
                  --out train/data/round2.jsonl --stats train/results/round2_stats.json ;;
    round2)     python train/sft.py --data train/data/round2.jsonl --init-adapter train/ckpt/sft --lr 5e-5 --liger --out train/ckpt/dagger \
                  --merge-out train/ckpt/dagger-merged &&
                python train/eval_llm.py --model train/ckpt/dagger-merged $EVAL --name dagger ;;
    round3)     # textbook DAgger aggregate continued from the SFT adapter: unseen teacher examples + every expert relabel,
                # no self-imitation (round 2's kept student episodes coincided with over-reservation)
                python train/aggregate.py --sft train/data/sft_ref.jsonl --seen $SFT_LIMIT --relabel train/data/dagger_relabel.jsonl \
                  --out train/data/round3.jsonl &&
                python train/sft.py --data train/data/round3.jsonl --init-adapter train/ckpt/sft --lr 1e-4 --liger \
                  --out train/ckpt/dagger3 --merge-out train/ckpt/dagger3-merged &&
                python train/eval_llm.py --model train/ckpt/dagger3-merged $EVAL --name dagger3 ;;
    *)          echo "unknown stage $stage"; return 1 ;;
  esac
}
{ date; run && echo STAGE_OK || echo STAGE_FAILED; date; } 2>&1 | tee train/logs/$stage.log
