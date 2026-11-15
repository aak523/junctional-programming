"""Where does an agent's money go? The mistake report the verifier attaches to every game, and its CLI.

usage: python compare.py [jobs dir]      (default: harbor/jobs)
Reads each trial's verifier/details.json (the world's seed, the agent's actions and belief notes), replays the game and
the reference on the same world, and prints both summaries side by side with the findings. The replay uses the current
rules, so only games played under them (v5) replay faithfully.
"""
import json
import re
import sys
from pathlib import Path

import policies
import world as W

HERE = Path(__file__).parent


def replay(seed, actions):
    w = W.World(seed)
    for a in actions:
        try:
            w.command(a)
        except ValueError:
            pass
    w.finish()
    return w


def reference(seed):
    return policies.run(policies.LPPolicy, seed)


def summary(w):
    """One finished game's decisions in numbers ($M, kH-months)."""
    s, c = w.settlement, w.settlement["costs"]
    done = [w.window_training(a, d) for a, d, _ in W.MILESTONES]
    return {"net_cost": s["net_cost"], "runs_met": s["milestones_met"],
            "window_fill": [round(x / t, 2) for x, (*_, t) in zip(done, W.MILESTONES)],   # compute delivered / the run's need
            "surplus_training": round(sum(max(0.0, x - t) for x, (*_, t) in zip(done, W.MILESTONES))),
            "gpu_spend": c["capex"], "resale_income": 0.0 - c["resale"], "contracts": c["contracts"], "spot": c["spot"],
            "options": c["options"], "power": c["power"], "unserved": c["unserved"],
            "interest_charged": round(sum(max(0.0, h["interest"]) for h in w.history), 2),
            "min_cash": min(h["cash_end"] for h in w.history), "broker_orders": dict(w.broker_orders),
            "end_mark": s["mark_to_market"], "obligations_after_23": s["obligations"], "penalties": s["penalties"]}


# a note's claim about this month's supply regime: "m5 was loose" / "M9 ~85% TIGHT" (explicit month), else
# "supply=loose", "Supply ~85% tight", "regime: LOOSE", "LOOSE regime"
_EXPLICIT = re.compile(r"\bm(\d{1,2})\s+(?:was\s+|is\s+)?(?:~?>?\d+\s*(?:%|pct)\s*)?(loose|tight)\b", re.I)
_REGIME = re.compile(r"(?:supply|regime)[\s=:~]*(?:~?>?\d+\s*(?:%|pct)\s*)?(loose|tight)\b|\b(loose|tight)\s+regime", re.I)
_UNTESTED = re.compile(r"untested|unknown|50/50", re.I)


def regime_claim(note):
    for m in _EXPLICIT.finditer(note["text"]):
        if int(m.group(1)) == note["month"]:
            return m.group(2).lower()
    m = _REGIME.search(note["text"])
    return (m.group(1) or m.group(2)).lower() if m else None


def beliefs(w, notes):
    """What the belief log knew: regime claims checked against the truth, and months it called the brokers untested."""
    claims = [(n["month"], c) for n in notes if n["month"] < W.T and (c := regime_claim(n))]
    broker_notes = sum(1 for n in notes if re.search(r"broker", n["text"], re.I) and _UNTESTED.search(n["text"]))
    return {"notes": len(notes), "regime_claims": len(claims), "regime_right": sum(c == w.regime[k] for k, c in claims),
            "months_brokers_called_untested": broker_notes}


def diagnose(w, ref, notes=()):
    """The agent's finished World against the reference's on the same world: both summaries, the cost gap by line,
    the belief-log check and plain-text findings."""
    a, r = summary(w), summary(ref)
    b = beliefs(w, list(notes))
    lines = [("GPUs", "gpu_spend"), ("resale", "resale_income", -1), ("contracts", "contracts"), ("spot", "spot"),
             ("options", "options"), ("power", "power"), ("unserved inference", "unserved"), ("interest", "interest_charged"),
             ("end-of-game mark", "end_mark", -1), ("obligations after month 23", "obligations_after_23"), ("penalties", "penalties")]
    gap = {name: round(sign[0] * (a[key] - r[key]) if sign else a[key] - r[key], 1) for name, key, *sign in lines}
    f = []
    for i, ((x, y), (first, last, t)) in enumerate(zip(zip(a["window_fill"], r["window_fill"]), W.MILESTONES)):
        if x < 1 - 1e-6:
            f.append(f"Missed training run {i + 1} (months {first}..{last}): {x:.2f}x of the {t:g} kH-months it needed.")
        elif x >= 1.25 and x >= y + 0.2:
            f.append(f"Training run {i + 1}: delivered {x:.2f}x the compute it needed (reference {y:.2f}x).")
    if a["gpu_spend"] > r["gpu_spend"] + 100:
        f.append(f"Spent ${a['gpu_spend']:.0f}M on GPUs net of refunds (reference ${r['gpu_spend']:.0f}M) and resold "
                 f"${a['resale_income']:.0f}M (reference ${r['resale_income']:.0f}M).")
    if a["interest_charged"] > r["interest_charged"] + 10:
        f.append(f"Paid ${a['interest_charged']:.0f}M of interest on debt, lowest cash ${a['min_cash']:.0f}M "
                 f"(reference ${r['interest_charged']:.0f}M, lowest ${r['min_cash']:.0f}M).")
    if a["obligations_after_23"] > r["obligations_after_23"] + 50:
        f.append(f"Left ${a['obligations_after_23']:.0f}M of contracts and power running past month 23 (reference ${r['obligations_after_23']:.0f}M).")
    if a["unserved"] > r["unserved"] + 20:
        f.append(f"Left ${a['unserved']:.0f}M of inference demand unserved (reference ${r['unserved']:.0f}M).")
    never = [x for x, n in a["broker_orders"].items() if n == 0]
    if never:
        f.append(f"Never ordered from broker {' or '.join(never)}, so it never learned whether "
                 f"{'they are' if len(never) > 1 else 'it is'} reliable (the reference probes each broker in month 0)"
                 + (f"; its notes call the brokers untested or unknown in {b['months_brokers_called_untested']} months." if
                    b["months_brokers_called_untested"] >= 3 else "."))
    if b["regime_claims"] >= 6 and a["net_cost"] > r["net_cost"]:
        f.append(f"Its notes named the supply regime correctly in {b['regime_right']} of the {b['regime_claims']} months they "
                 f"stated one: it read the market, and the gap comes from what it did about it.")
    worse = [f"{k} {v:+.0f}" for k, v in sorted(gap.items(), key=lambda kv: -kv[1])[:3] if v >= 1]
    better = [f"{k} {v:+.0f}" for k, v in sorted(gap.items(), key=lambda kv: kv[1])[:3] if v <= -1]
    lines_vs = "; ".join(", ".join(x) for x in (worse, better) if x)
    f.append(f"Net cost ${a['net_cost']:.0f}M vs the reference's ${r['net_cost']:.0f}M"
             + (f" ($M against the reference: {lines_vs})." if lines_vs else "."))
    return {"agent": a, "reference": r, "cost_gap_vs_reference": gap, "beliefs": b, "findings": f}


def table(dg):
    a, r = dg["agent"], dg["reference"]
    for k in a:
        print(f"  {k:22} {str(a[k]):>28} {str(r[k]):>28}")
    for x in dg["findings"]:
        print("  -", x)


if __name__ == "__main__":
    jobs = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "harbor" / "jobs"
    for f in sorted(jobs.glob("*/*/verifier/details.json")) + sorted(jobs.glob("*/verifier/details.json")):
        d = json.loads(f.read_text())
        if "seed" not in d or not d.get("actions"):
            continue
        seed = d["seed"]
        ref = reference(seed)
        print(f"=== {f.parts[-4]} / {f.parts[-3]}: recorded reward {d['reward']} (reference {d['scale']['reference_reward']} when played) | "
              f"hidden: regime {''.join(x[0] for x in ref.regime)} launch {ref.launch} export {ref.export} "
              f"brokers reliable {ref.broker_reliable} decay {ref.broker_decay} growth {ref.growth[0]} switch {ref.growth_switch}")
        print(f"  {'':22} {'agent':>28} {'reference':>28}")
        table(diagnose(replay(seed, d["actions"]), ref, d.get("notes", [])))
