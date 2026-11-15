"""Play many GPU World episodes with one vLLM model in lockstep: one batched chat call per month.

usage: python train/rollout.py --model train/ckpt/sft-merged --seeds 11000 11100 --k 6 --temperature 0.8 --out train/data/dagger_samples.jsonl
The only module that imports vllm. Models are plain HF directories (base, or LoRA merged into the base).
"""
import argparse
import json
import multiprocessing as mp
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402
from gen_sft import episode_fields, oracle_cost  # noqa: E402


def oracle_costs(seeds, procs):
    # before vLLM starts: forked workers must not inherit a CUDA context
    with ProcessPoolExecutor(procs, mp_context=mp.get_context("spawn")) as ex:
        return dict(zip(seeds, ex.map(oracle_cost, seeds)))


def load_llm(model, gpu_mem=0.85, max_model_len=8192):
    from vllm import LLM
    return LLM(model=model, max_model_len=max_model_len, gpu_memory_utilization=gpu_mem, enable_prefix_caching=True,
               max_num_seqs=512, seed=0)


def play(llm, seeds, k, temperature, policy, max_tokens=300, procs=8, oracle=None):
    """Returns one record per (seed, sample, month), with the episode's settled outcome on every record."""
    from vllm import SamplingParams
    oracle = oracle or oracle_costs(sorted(set(seeds)), procs)
    eps = [(seed, j, E.Episode(seed)) for seed in seeds for j in range(k)]
    recs = {(seed, j): [] for seed, j, _ in eps}
    for month in range(24):
        msgs = [ep.messages() for _, _, ep in eps]
        params = [SamplingParams(temperature=temperature, max_tokens=max_tokens,
                                 seed=None if temperature == 0 else seed * 1000 + j * 24 + month) for seed, j, _ in eps]
        # Qwen3 hybrid models: no thinking block (the 2507 instruct template ignores the switch)
        outs = llm.chat(msgs, params, use_tqdm=False, chat_template_kwargs={"enable_thinking": False})
        for (seed, j, ep), m, o in zip(eps, msgs, outs):
            st = ep.step(o.outputs[0].text)
            recs[seed, j].append({"seed": seed, "policy": policy, "sample": j, "month": month, "system_sha": E.SYSTEM_SHA,
                                  "user": m[1]["content"], "completion": st["completion"], "executed": st["executed"],
                                  "errors": st["errors"], "forced_end": st["forced_end"],
                                  "finish": o.outputs[0].finish_reason})
        print(f"month {month}: {sum(r[-1]['errors'] for r in recs.values())} errors, "
              f"{sum(r[-1]['forced_end'] for r in recs.values())} forced ends in {len(eps)} episodes", flush=True)
    out = []
    for seed, j, ep in eps:
        fields = episode_fields(ep.result(), oracle[seed])
        for r in recs[seed, j]:
            r["episode"] = fields
        out += recs[seed, j]
    return out


def write(recs, path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--seeds", type=int, nargs=2, required=True, metavar=("FIRST", "END"))
    ap.add_argument("--k", type=int, default=1)
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--policy", default="sft_student")
    ap.add_argument("--procs", type=int, default=8)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    seeds = list(range(*a.seeds))
    oracle = oracle_costs(seeds, a.procs)
    recs = play(load_llm(a.model), seeds, a.k, a.temperature, a.policy, procs=a.procs, oracle=oracle)
    write(recs, a.out)
    rewards = [r["episode"]["reward"] for r in recs if r["month"] == 0]
    print(f"{len(rewards)} episodes, mean reward {sum(rewards) / len(rewards):.4f} -> {a.out}")


if __name__ == "__main__":
    main()
