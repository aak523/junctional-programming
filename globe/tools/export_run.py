"""Export a GPU World run as month-by-month JSON for the globe.

usage: python export_run.py <repo dir> <policy> <seed> <out.json> [rules label]
       python export_run.py <repo dir> <harbor verifier details.json> - <out.json> [rules label]   (replay an agent's run)
The repo dir's world.py and policies.py play the run, so export a game with the code it was played under (e.g. a
worktree of an older commit): an agent replay whose final net cost differs from the one Harbor recorded stops with an
error instead of writing a different game. The rules label defaults to world.RULES (code before v5 has none: pass it).

Each month (and start) also lists power: the power contracts not yet over after the month's commands
({site, mw, start, end (exclusive), ref: [month, command index] of the contract_power command, null for the
starting contracts}).
Each month also carries prices: what the agent saw at the start of that month (spot and reserve per kH-month
before the site multiplier, gpu list and broker prices per thousand GPUs, used-market value per thousand GPUs).
Each month also carries news: the headlines the agent saw at the start of that month.
Each month also carries options: kH of options held after the month's commands.
A replayed agent run also carries notes: the agent's belief-log entries written during each month.

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
Money ($M): commands[i].cost is what each command cost (negative for income); cash is the cash after the month's
commands; costs is spending so far by category; month_end is what the settlement took from cash at each site (power,
contracts, spot; unserved inference counts towards the score but is never paid from cash) and in interest, and refunded at each supplier; deliveries[].value is what the delivered GPUs cost (the refund for a
cancelled order, the shipping cost for a move); if_stopped is the final score if the agent stopped sending commands
here (the game's own finish(): standing contracts run on, then settlement), with its score (world.score against the
oracle's net cost on the same world; code before world.score used min(1, oracle / net cost)). month_end.funding is the
funding paid at the month's end.
The top level also carries the oracle's net cost (oracle), the score formula (score_rule), the rules label and the code commit (rules_version, code),
the rules a player knows about money and hardware, and the rules a player knows about demand and training (rules) and the state before any
command (start: sites with owned, powered and own compute, and waiting).
"""
import copy
import json
import pathlib
import subprocess
import sys
from collections import defaultdict

repo, name, seed, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
label = sys.argv[5] if len(sys.argv) > 5 else None
sys.path.insert(0, repo)
import policies  # noqa: E402
import world as W  # noqa: E402

NOTES = {}   # month -> the agent's notes that month
if name.endswith(".json"):
    # An agent's run, from the Harbor verifier's details: its seed, the commands the world accepted, and its notes.
    details = json.load(open(name))
    seed = details["seed"]
    by_month = [[]]
    for a in details["actions"]:
        if a == "end_month":
            by_month.append([])
        else:
            by_month[-1].append(a)
    for n in details.get("notes", []):
        NOTES.setdefault(n["month"], []).append(n["text"])

    def replay():
        def pol(obs, act):
            for c in by_month[obs["month"]] if obs["month"] < len(by_month) else []:
                act(c)
        return pol
    name = pathlib.Path(name).resolve().parts[-4]   # the Harbor job, e.g. fable-5-v4
    POLICY = (replay, None)
else:
    details = None
    seed = int(seed)
    POLICY = policies.LADDER[name]
RULES_VERSION = label or getattr(W, "RULES", None)
if RULES_VERSION is None:
    sys.exit("this code has no world.RULES: pass the rules label (e.g. v4) as the 5th argument")
CODE = subprocess.run(["git", "-C", repo, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or None
ORACLE = policies.play(policies.OracleMPC, seed)["net_cost"]   # the score's yardstick on this world, by this code


SCORE_RULE = ("oracle's net cost / net cost (at most 1) x runs met / 3" if hasattr(W, "score")
              else "oracle's net cost / net cost (at most 1)")


def score(net_cost, met):
    if hasattr(W, "score"):
        return round(W.score(net_cost, ORACLE, met), 4)
    return round(1.0 if net_cost <= ORACLE else max(0.0, ORACLE / net_cost), 4)   # the reward before world.score

SUPPLIERS = ("vendor",) + tuple(W.BROKERS)


def if_stopped(world):
    w2 = copy.deepcopy(world)
    st = w2.finish()
    return {**{k: st[k] for k in ("net_cost", "spend", "mark_to_market", "obligations", "penalties", "milestones_met")},
            "score": score(st["net_cost"], st["milestones_met"])}


def costs(world):
    return {k: round(v, 2) for k, v in world.cost.items()}


def waiting(queue):
    out = {s: {"H": 0.0, "N": 0.0} for s in SUPPLIERS}
    for o in queue:
        if o["left"] > 1e-9:
            out[o["src"]][o["gen"]] += o["left"]
    return {s: {g: round(v, 3) for g, v in d.items()} for s, d in out.items()}


pol_factory, stop = POLICY
w = W.World(seed)
pol = pol_factory(w) if getattr(pol_factory, "needs_world", False) else pol_factory()
months = []
# The world before any command: GPUs already at the sites, what month 0's power would run, and orders already queued.
start = {"sites": {}, "waiting": waiting(w.queue), "cash": round(w.cash, 2), "costs": costs(w), "if_stopped": if_stopped(w)}
for s_ in W.SITES:
    _, pw = w.powered(s_, 0)
    start["sites"][s_] = {"owned": {g: round(v, 3) for g, v in w.owned[s_].items()},
                          "powered": {g: round(v, 2) for g, v in pw.items()},
                          "own": round(sum(pw[g] * W.COMPUTE[g] for g in pw), 2)}
order_ref = {}   # order id -> [month, index of its buy_gpus command in that month's list]
power_ref = {}   # index in world.power -> [month, index of its contract_power command]


def power_now(k):
    """Power contracts not yet over at month k: energised ones and signed ones still to switch on."""
    return [{"site": p["site"], "mw": p["mw"], "start": p["start"], "end": p["end"], "ref": power_ref.get(i)}
            for i, p in enumerate(w.power) if p["end"] > k]


start["power"] = power_now(0)
while w.t < W.T:
    commands = []
    obs = w.observe()
    p, news = obs["prices"], obs["news"]
    prices = {"spot": p["spot"], "reserve": {str(m): v for m, v in p["reserve"].items()}, "gpu": p["gpu"], "broker": p["broker"],
              "market_value": p["market_value"]}

    def act(c):
        cash0 = w.cash
        try:
            r = w.command(c)
        except ValueError:
            commands.append({"c": c, "ok": False})
            raise
        commands.append({"c": c, "ok": True, "cost": round(cash0 - w.cash, 2)})
        if c.split()[0] == "buy_gpus":
            order_ref[w.next_id - 1] = [len(months), len(commands) - 1]
        if c.split()[0] == "contract_power":
            power_ref[len(w.power) - 1] = [len(months), len(commands) - 1]
        return r

    if stop is None or w.t < stop:
        try:
            pol(w.observe(), act)
        except ValueError:
            pass
    owned = {s: {g: round(v, 3) for g, v in w.owned[s].items()} for s in W.SITES}
    cash_now, costs_now, stopped = round(w.cash, 2), costs(w), if_stopped(w)
    power = power_now(w.t)
    paid = {o["id"]: o["paid"] / o["qty"] for o in w.queue}   # $M per thousand GPUs of each order
    k = w.t
    contract_cost = {s: sum(c["qty"] * c["price"] for c in w.contracts if c["site"] == s and c["start"] <= k < c["end"]) for s in W.SITES}
    before = waiting(w.queue)
    pending = [order_ref[o["id"]] + [round(o["left"], 3)] for o in w.queue if o["left"] > 1e-9 and o["id"] in order_ref]
    left_before = {o["id"]: (o["src"], o["site"], o["gen"], o["left"]) for o in w.queue if o["src"] == "vendor"}
    w.end_month()
    rep = w.history[-1]
    left_after = {o["id"]: o["left"] for o in w.queue}
    agg, refs, value = defaultdict(float), defaultdict(list), defaultdict(float)
    for oid, (src, site, gen, left) in left_before.items():
        shipped = left - left_after.get(oid, 0.0)
        if shipped > 1e-9:
            agg[(src, site, gen, True)] += shipped
            value[(src, site, gen, True)] += shipped * paid.get(oid, 0.0)
            if oid in order_ref:
                refs[(src, site, gen, True)].append(order_ref[oid])
    for b in rep["broker"]:
        key = (b["src"], b["site"], b["gen"], b["delivered"])
        agg[key] += b["qty"]
        value[key] += b["qty"] * paid.get(b["id"], 0.0) * (1 if b["delivered"] else W.BROKER_REFUND)
        if b["id"] in order_ref:
            refs[key].append(order_ref[b["id"]])
    deliveries = [{"src": s, "site": site, "gen": g, "qty": round(q, 3), "ok": ok, "orders": refs[(s, site, g, ok)],
                   "value": round(value[(s, site, g, ok)], 2)} for (s, site, g, ok), q in agg.items()]
    # GPU moves between datacentres made this month arrive for next month (the world does not keep the source site,
    # so read it from the command: move_gpus <qty> <gen> <from> <to>).
    for i, c in enumerate(commands):
        parts = c["c"].split()
        if c["ok"] and parts[0] == "move_gpus" and len(parts) >= 5:
            deliveries.append({"src": parts[3], "site": parts[4], "gen": parts[2], "qty": float(parts[1]), "ok": True,
                               "move": True, "orders": [[len(months), i]], "value": c.get("cost", 0.0)})
    months.append({"month": len(months), "commands": commands,
                   "sites": {s: {"owned": owned[s], "powered": rep["sites"][s]["powered"]} for s in W.SITES},
                   "waiting": before, "pending": pending, "deliveries": deliveries, "remaining": waiting(w.queue),
                   "settle": {s: {"demand": x["demand"], "served": x["served"], "own": x["own_compute"], "reserved": x["reserved"],
                                  "spot_req": x["spot_requested"], "spot": x["spot_filled"], "training": x["training"]}
                              for s, x in rep["sites"].items()},
                   "window_training": [round(w.window_training(a, d), 2) for a, d, _ in W.MILESTONES],
                   "cash": cash_now, "costs": costs_now, "if_stopped": stopped,
                   "month_end": {"sites": {s: round(x["power_mw"] * W.POWER_COST[s] + contract_cost[s]
                                                    + x["spot_filled"] * rep["spot_price"] * W.SITE_PRICE[s], 2)
                                           for s, x in rep["sites"].items()},
                                 "interest": rep["interest"], "funding": rep.get("funding", W.FUNDING),
                                 "refunds": {b["src"]: round(b["qty"] * paid.get(b["id"], 0.0) * W.BROKER_REFUND, 2)
                                             for b in rep["broker"] if not b["delivered"]}},
                   "met": {str(d): v for d, v in w.met.items()}, "notes": NOTES.get(len(months), []),
                   "power": power, "prices": prices, "news": news, "options": round(w.options, 2)})
final = months[-1]["if_stopped"]["net_cost"]
if details is not None and abs(final - details["net_cost"]) > 0.01:
    sys.exit(f"replay ends at net cost {final}, but Harbor recorded {details['net_cost']}: this code is not the code the game "
             f"was played under (export it from that commit)")
rules = {"site_price": W.SITE_PRICE, "power_cost": W.POWER_COST, "unserved_cost": W.UNSERVED_INFERENCE,
         "option": {"premium": W.OPTION_PREMIUM, "strike": W.OPTION_STRIKE, "term": W.OPTION_TERM},
         "demand_start": W.DEMAND0, "growth": list(W.GROWTH), "noise": W.DEMAND_NOISE, "share": W.INF_SHARE,
         "milestones": [list(m) for m in W.MILESTONES], "funding": W.FUNDING, "credit": W.CREDIT,
         "ops_per_month": W.OPS_PER_MONTH, "power_mw": W.POWER_MW, "compute": W.COMPUTE}
json.dump({"policy": name, "seed": seed, "rules_version": RULES_VERSION, "code": CODE, "oracle": ORACLE, "score_rule": SCORE_RULE, "rules": rules,
           "start": start, "months": months}, open(out, "w"), separators=(",", ":"))
print(f"{name} seed {seed} (rules {RULES_VERSION}): net cost {final}, score {months[-1]['if_stopped']['score']}; {len(months)} months; deliveries {sum(len(m['deliveries']) for m in months)}, "
      f"cancelled {sum(1 for m in months for d in m['deliveries'] if not d['ok'])}, "
      f"peak vendor queue {max(sum(m['waiting']['vendor'].values()) for m in months):.1f}k")
