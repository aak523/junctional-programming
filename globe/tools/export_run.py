"""Export a GPU World run as month-by-month JSON for the globe.

usage: python export_run.py <repo dir> <policy> <seed> <out.json>

Each month records the commands the policy sent ([{c, ok}], ok false when the world refused it) and,
after that month's actions and before the month-end settlement:
  sites[site].owned / .powered   GPUs owned at the datacentre and how many were powered (thousands, by gen)
  waiting[supplier]              GPUs ordered from that supplier and not yet delivered (thousands, by gen)
  pending                        [[month, command index, thousands still to come]] for each undelivered buy order
and, for the month-end settlement that leads into the next month:
  deliveries                     [{src, site, gen, qty, ok}] - vendor shipments, broker orders that
                                 were delivered (ok true) or cancelled and refunded (ok false), and GPU
                                 moves between datacentres (move true; src is the source datacentre).
                                 orders: [[month, command index]] of the commands each one fulfils
  remaining[supplier]            what is still waiting at each supplier after the settlement
  settle[site]                   the month's result at each site: inference demand and how much was served, compute
                                 from owned powered GPUs (own), reserved
                                 and spot compute (spot_req is the standing request, spot what was filled) and the
                                 capacity left over for training (kH)
  window_training                training done so far in each training window, including this month (kH-months)
  met                            {last month of window: true/false} for windows already decided
The top level also carries the rules a player knows about demand and training (rules).
"""
import json
import sys
from collections import defaultdict

repo, name, seed, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
sys.path.insert(0, repo)
import policies  # noqa: E402
import world as W  # noqa: E402

SUPPLIERS = ("vendor",) + tuple(W.BROKERS)


def waiting(queue):
    out = {s: {"H": 0.0, "N": 0.0} for s in SUPPLIERS}
    for o in queue:
        if o["left"] > 1e-9:
            out[o["src"]][o["gen"]] += o["left"]
    return {s: {g: round(v, 3) for g, v in d.items()} for s, d in out.items()}


pol_factory, stop = policies.LADDER[name]
w = W.World(seed)
pol = pol_factory(w) if getattr(pol_factory, "needs_world", False) else pol_factory()
months = []
order_ref = {}   # order id -> [month, index of its buy_gpus command in that month's list]
while w.t < W.T:
    commands = []

    def act(c):
        try:
            r = w.command(c)
        except ValueError:
            commands.append({"c": c, "ok": False})
            raise
        commands.append({"c": c, "ok": True})
        if c.split()[0] == "buy_gpus":
            order_ref[w.next_id - 1] = [len(months), len(commands) - 1]
        return r

    if stop is None or w.t < stop:
        try:
            pol(w.observe(), act)
        except ValueError:
            pass
    owned = {s: {g: round(v, 3) for g, v in w.owned[s].items()} for s in W.SITES}
    before = waiting(w.queue)
    pending = [order_ref[o["id"]] + [round(o["left"], 3)] for o in w.queue if o["left"] > 1e-9 and o["id"] in order_ref]
    left_before = {o["id"]: (o["src"], o["site"], o["gen"], o["left"]) for o in w.queue if o["src"] == "vendor"}
    w.end_month()
    rep = w.history[-1]
    left_after = {o["id"]: o["left"] for o in w.queue}
    agg, refs = defaultdict(float), defaultdict(list)
    for oid, (src, site, gen, left) in left_before.items():
        shipped = left - left_after.get(oid, 0.0)
        if shipped > 1e-9:
            agg[(src, site, gen, True)] += shipped
            if oid in order_ref:
                refs[(src, site, gen, True)].append(order_ref[oid])
    for b in rep["broker"]:
        key = (b["src"], b["site"], b["gen"], b["delivered"])
        agg[key] += b["qty"]
        if b["id"] in order_ref:
            refs[key].append(order_ref[b["id"]])
    deliveries = [{"src": s, "site": site, "gen": g, "qty": round(q, 3), "ok": ok, "orders": refs[(s, site, g, ok)]}
                  for (s, site, g, ok), q in agg.items()]
    # GPU moves between datacentres made this month arrive for next month (the world does not keep the source site,
    # so read it from the command: move_gpus <qty> <gen> <from> <to>).
    for i, c in enumerate(commands):
        parts = c["c"].split()
        if c["ok"] and parts[0] == "move_gpus" and len(parts) >= 5:
            deliveries.append({"src": parts[3], "site": parts[4], "gen": parts[2], "qty": float(parts[1]), "ok": True,
                               "move": True, "orders": [[len(months), i]]})
    months.append({"month": len(months), "commands": commands,
                   "sites": {s: {"owned": owned[s], "powered": rep["sites"][s]["powered"]} for s in W.SITES},
                   "waiting": before, "pending": pending, "deliveries": deliveries, "remaining": waiting(w.queue),
                   "settle": {s: {"demand": x["demand"], "served": x["served"], "own": x["own_compute"], "reserved": x["reserved"],
                                  "spot_req": x["spot_requested"], "spot": x["spot_filled"], "training": x["training"]}
                              for s, x in rep["sites"].items()},
                   "window_training": [round(w.window_training(a, d), 2) for a, d, _ in W.MILESTONES],
                   "met": {str(d): v for d, v in w.met.items()}})
rules = {"demand_start": 6.0, "growth": list(W.GROWTH), "noise": 0.05, "share": W.INF_SHARE,
         "milestones": [list(m) for m in W.MILESTONES]}
json.dump({"policy": name, "seed": seed, "rules": rules, "months": months}, open(out, "w"), separators=(",", ":"))
print(f"{len(months)} months; deliveries {sum(len(m['deliveries']) for m in months)}, "
      f"cancelled {sum(1 for m in months for d in m['deliveries'] if not d['ok'])}, "
      f"peak vendor queue {max(sum(m['waiting']['vendor'].values()) for m in months):.1f}k")
