#!/bin/bash
# First-boot setup of the training box (runs as root). Log: /var/log/gpu-world-setup.log
exec > /var/log/gpu-world-setup.log 2>&1
set -x
export HOME=/root PATH=/root/.local/bin:$PATH
apt-get update -q && apt-get install -y -q git tmux
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone -b train https://github.com/aak523/junctional-programming.git /root/jp
uv venv --python 3.12 /root/venv
. /root/venv/bin/activate
STACK="vllm trl peft datasets accelerate matplotlib hf_transfer"
# the Harbor images pin numpy/scipy; keep the same LP numerics unless the stack cannot resolve with them
uv pip install $STACK numpy==2.1.3 scipy==1.14.1 || uv pip install $STACK
HF_HUB_ENABLE_HF_TRANSFER=1 hf download Qwen/Qwen3-4B-Instruct-2507
uv pip freeze > /root/requirements.txt
if python -c "import vllm, trl, peft, transformers, torch; assert torch.cuda.is_available(); print(vllm.__version__, trl.__version__, transformers.__version__, torch.__version__)"; then
  touch /root/SETUP_DONE
else
  touch /root/SETUP_FAILED
fi
