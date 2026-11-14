"""DAgger labels: replay the student's episodes and ask the reference what it would do in every state the student
actually reached. The expert keeps its own Bayesian filter over the student's real history; its actions run in a
shadow copy of the world, and the student's actions run in the real one. Next month's cap-fill evidence is about
what the student asked for, since that is what the student's world shows.

usage: python train/relabel.py train/data/dagger_samples.jsonl --per-seed 4 --procs 28 --out train/data/dagger_relabel.jsonl
       python train/relabel.py --check train/data/smoke.jsonl     (relabelling reference episodes must reproduce them)
"""
import argparse
import copy
import hashlib
import json
import random
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402
import policies  # noqa: E402
import world as W  # noqa: E402
from gen_sft import episodes, load  # noqa: E402


def asked_by(cmds):
    asked = {s: 0.0 for s in W.SITES}
    for c in cmds:
        p = c.split()
        if p[0] == "reserve" and len(p) > 3 and p[3] in asked:
            asked[p[3]] += round(float(p[1]), 2)
    return asked


def relabel_episode(recs):
    seed = recs[0]["seed"]
    ep = E.Episode(seed)
    bel = policies.Bayes()
    pol = policies.LPPolicy(bel)
    out = []
    for r in recs:
        assert ep.month == r["month"] and ep.user() == r["user"], (seed, r["month"], "replay diverged from the student's prompt")
        obs = ep.observe()
        shadow = copy.deepcopy(ep._w)
        cmds = []

        def act(c):
            res = shadow.command(c)
            cmds.append(c)
            return res
        pol(obs, act)
        note = E.synth_note(bel, obs, cmds)
        out.append({**{k: r[k] for k in ("seed", "sample", "month", "user", "episode")}, "policy": "dagger_expert",
                    "system_sha": E.SYSTEM_SHA, "completion": E.completion_of(note, cmds), "executed": cmds,
                    "errors": 0, "forced_end": False})
        # the student's month: its notes (they shape later prompts) and its accepted actions, in order
        for n in [s for s in E.parse(r["completion"])[0] if s.split()[0] == "note"]:
            ep.note(n[4:].strip())
        for c in r["executed"]:
            ep.act_direct(c)
        bel.note_actions(obs, asked_by(r["executed"]))
        ep.close_month()
    return out


def pick(eps, per_seed, rng):
    by_seed = {}
    for (seed, sample), recs in eps.items():
        by_seed.setdefault(seed, []).append(recs)
    chosen = []
    for seed, group in sorted(by_seed.items()):
        group.sort(key=lambda recs: recs[0]["episode"]["reward"])
        pickd = [group[-1], group[0]]
        rest = group[1:-1]
        rng.shuffle(rest)
        pickd += rest[:max(0, per_seed - 2)]
        chosen += [g for i, g in enumerate(pickd) if all(g is not h for h in pickd[:i])][:per_seed]
    return chosen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples", nargs="?")
    ap.add_argument("--per-seed", type=int, default=4)
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--out")
    ap.add_argument("--check")
    a = ap.parse_args()
    if a.check:
        eps = list(episodes(load(a.check)).values())
        with ProcessPoolExecutor(a.procs) as ex:
            for recs, lab in zip(eps, ex.map(relabel_episode, eps)):
                for r, x in zip(recs, lab):
                    assert x["completion"] == r["completion"], (r["seed"], r["month"], x["completion"], r["completion"])
        print(f"relabel check passed: {len(eps)} episodes reproduce the reference exactly")
        return
    chosen = pick(episodes(load(a.samples)), a.per_seed, random.Random(0))
    seen, n = set(), 0
    with ProcessPoolExecutor(a.procs) as ex, open(a.out, "w", encoding="utf-8") as f:
        for lab in ex.map(relabel_episode, chosen):
            for x in lab:
                key = (x["seed"], hashlib.sha1(x["user"].encode()).hexdigest())
                if key not in seen:
                    seen.add(key)
                    f.write(json.dumps(x) + "\n")
                    n += 1
            f.flush()
    print(f"relabelled {len(chosen)} student episodes -> {n} unique states")


if __name__ == "__main__":
    main()
