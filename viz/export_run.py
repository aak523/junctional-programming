"""Export one game as a frame-per-month JSON for the 3D visualisation (viz/index.html).

    python viz/export_run.py policy reference 3          -> viz/data/reference-3.json
    python viz/export_run.py harbor harbor/jobs/fable-5-v4/.../verifier/details.json
    python viz/export_run.py all                         -> the default set + viz/data/index.json

A frame holds the state the month was played with (owned GPUs, power, in-transit orders, contracts)
and what the month produced (capacity, demand served, training, shipments, cash), so the viewer can
scrub the whole 24 months without re-running the world.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import world as W

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def snapshot(w):
    """State as it stands before the month is run: what the player has committed to."""
    return {
        "cash": round(w.cash, 2),
        "options": round(w.options, 2),
        "owned": {s: {g: round(v, 2) for g, v in w.owned[s].items()} for s in W.SITES},
        "queue": [{"id": o["id"], "src": o["src"], "gen": o["gen"], "qty": round(o["qty"], 2),
                   "left": round(o["left"], 2), "placed": o["placed"], "site": o["site"],
                   "paid": round(o["paid"], 2),
                   "ready": o["placed"] + (W.MIN_LEAD if o["src"] == "vendor" else 2)}
                  for o in w.queue],
        "moves": [{"gen": m["gen"], "qty": round(m["qty"], 2), "to": m["to"], "arrive": m["arrive"]} for m in w.moves],
        "contracts": [{"qty": round(c["qty"], 2), "price": round(c["price"], 3), "start": c["start"],
                       "end": c["end"], "site": c["site"], "option": bool(c.get("option"))}
                      for c in w.contracts if c["end"] > w.t],
        "power": [{"mw": p["mw"], "start": p["start"], "end": p["end"], "site": p["site"]} for p in w.power],
        "spot_level": {s: round(w.spot_level[s], 2) for s in W.SITES},
    }


def frame(w, k, acts, note):
    """One finished month: the pre-month commitments plus the month's realised outcome."""
    pre = snapshot(w)                      # taken before end_month by the caller
    h = w.history[-1]
    return {
        "month": k,
        "actions": acts,
        "note": note,
        "news": w.news[k],
        "regime": w.regime[k],             # hidden from the player; shown behind a "truth" toggle
        "export_active": w.export_active(k),
        "launched": k >= w.launch,
        "spot_price": h["spot_price"],
        "contract_index": round(w.cindex[k], 3),
        "market_value": {g: round(w.market_value(g, k), 2) for g in ("H", "N")},
        "demand": h["inference_demand"],
        "served": h["served"],
        "capacity": h["capacity"],
        "training": h["training"],
        "shipped": h["shipped"],
        "broker": h["broker"],
        "interest": h["interest"],
        "cash_end": h["cash_end"],
        "sites": h["sites"],
        "window_training": [round(w.window_training(a, d), 2) for a, d, _ in W.MILESTONES],
        "spent": {key: round(v, 2) for key, v in w.cost.items()},
        **pre,
    }


def run(make_play, seed, notes=None):
    """make_play(w) -> play_month(w, k), returning the action strings taken in month k."""
    w = W.World(seed)
    play_month = make_play(w)
    notes = notes or {}
    frames = []
    while w.t < W.T:
        k = w.t
        acts = play_month(w, k)
        pre = snapshot(w)
        w.end_month()
        f = frame(w, k, acts, notes.get(k, ""))
        f.update(pre)
        frames.append(f)
    return w, frames


def from_policy(name):
    import policies   # pulls in scipy; only needed for the scripted policies
    pol, stop = policies.LADDER[name]

    def make(w):
      p = pol(w) if getattr(pol, "needs_world", False) else pol()

      def play(w, k):
        acts = []
        if stop is not None and k >= stop:
            return acts

        def act(c):
            acts.append(c)
            return w.command(c)
        try:
            p(w.observe(), act)
        except ValueError as e:
            acts.append(f"# refused: {e}")
        return acts
      return play
    return make


def from_actions(actions):
    """Replay a real agent's action log: months are separated by end_month."""
    months, cur = [], []
    for a in actions:
        if a.strip() == "end_month":
            months.append(cur)
            cur = []
        else:
            cur.append(a)
    if cur:
        months.append(cur)

    def make(w):
      def play(w, k):
        acts = []
        for c in (months[k] if k < len(months) else []):
            try:
                w.command(c)
                acts.append(c)
            except ValueError as e:
                acts.append(f"# refused: {c} ({e})")
        return acts
      return play
    return make


def export(key, title, subtitle, make_play, seed, notes=None, meta=None):
    w, frames = run(make_play, seed, notes)
    doc = {"key": key, "title": title, "subtitle": subtitle, "seed": seed,
           "months": W.T, "milestones": W.MILESTONES, "sites": list(W.SITES),
           "frames": frames, "settlement": w.settlement,
           "truth": {"regime": w.regime, "launch": w.launch, "export": w.export,
                     "growth_switch": w.growth_switch,
                     "broker_reliable": w.broker_reliable, "broker_decay": w.broker_decay},
           "meta": meta or {}}
    path = os.path.join(OUT, f"{key}.json")
    with open(path, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(f"{path}  net cost ${w.settlement['net_cost']:.0f}M  milestones {w.settlement['milestones_met']}/3")
    return {"key": key, "title": title, "subtitle": subtitle,
            "net_cost": w.settlement["net_cost"], "milestones": w.settlement["milestones_met"],
            **(meta or {})}


def harbor(path):
    d = json.load(open(path))
    notes = {n["month"]: n["text"] for n in d.get("notes", [])}
    label = os.path.basename(os.path.dirname(os.path.dirname(path)))
    return d, notes, label


def main():
    os.makedirs(OUT, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1] == "policy":
        name, seed = sys.argv[2], int(sys.argv[3])
        export(f"{name}-{seed}", f"{name} (seed {seed})", "scripted policy", from_policy(name), seed)
        return
    if len(sys.argv) > 1 and sys.argv[1] == "harbor":
        d, notes, label = harbor(sys.argv[2])
        export(label, label, f"Harbor trial, reward {d['reward']}", from_actions(d["actions"]), d["seed"], notes,
               {"reward": d["reward"]})
        return

    # default set: the real Claude Fable 5 game, the reference on the same world, and a reference game of its own
    entries = []
    fab = "harbor/jobs/fable-5-v4/gpu-world__BpnMWA6/verifier/details.json"
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    fabp = os.path.join(root, fab)
    if os.path.exists(fabp):
        d, notes, _ = harbor(fabp)
        entries.append(export("fable5", "Claude Fable 5", f"Harbor v4 trial — reward {d['reward']}",
                              from_actions(d["actions"]), d["seed"], notes,
                              {"reward": d["reward"], "kind": "agent"}))
        entries.append(export("fable5-reference", "Reference policy", "same world as the Fable 5 trial",
                              from_policy("reference"), d["seed"], None, {"kind": "reference"}))
    entries.append(export("reference-3", "Reference policy", "evaluation seed 3",
                          from_policy("reference"), 3, None, {"kind": "reference"}))
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump(entries, fh, indent=1)
    print("wrote", os.path.join(OUT, "index.json"))


main()
