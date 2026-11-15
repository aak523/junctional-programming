#!/bin/bash
# Copy results, logs, eval dumps, the box's frozen requirements and the LoRA adapters (not checkpoints or merged
# weights) from the box into train/. usage (local, repo root): bash train/cloud/sync_down.sh [ip]
set -e
IP=${1:-$(cat train/cloud/box_ip)}
OPTS="-o StrictHostKeyChecking=accept-new"
ssh $OPTS root@$IP 'cd /root/jp/train && cp /root/requirements.txt results/box_requirements.txt &&
  files="results logs $(ls data/eval_*.jsonl 2>/dev/null)" &&
  for d in ckpt/sft ckpt/dagger; do [ -d $d ] && files="$files $(ls -d $d/adapter_* $d/*.json $d/*.jinja 2>/dev/null)"; done;
  tar czf /tmp/sync.tgz $files'
scp $OPTS root@$IP:/tmp/sync.tgz "${TMPDIR:-/tmp}/gpu-world-sync.tgz"
tar xzf "${TMPDIR:-/tmp}/gpu-world-sync.tgz" -C train
echo "synced from $IP"
