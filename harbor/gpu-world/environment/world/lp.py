"""Linear-programming model of GPU World.

`solve(state, paths, ...)` minimises expected settled net cost over one or more
future paths. Decisions for the current month are shared by all paths (they have
to be taken now); later decisions may differ per path. With the single true path
it is the perfect-information bound (`oracle`); with paths sampled from a Bayesian
posterior it is the planning core of the reference policy (`SAA reference`).

Relaxations relative to the world: quantities are continuous, the per-month
operation limit is ignored, broker orders deliver their expected fraction, and a
missed training run costs only its per-kH-month shortfall (the fixed penalty is dropped).
"""
import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix

import world as W
from world import T

TERMS = (6, 12, 24)


class Model:
    def __init__(self):
        self.c, self.bounds = [], []
        self.rows, self.cols, self.vals, self.rhs = [], [], [], []
        self.eq_rows, self.eq_cols, self.eq_vals, self.eq_rhs = [], [], [], []

    def var(self, cost=0.0, lb=0.0, ub=None):
        self.c.append(cost)
        self.bounds.append((lb, ub))
        return len(self.c) - 1

    def le(self, terms, rhs):
        r = len(self.rhs)
        for v, a in terms:
            self.rows.append(r), self.cols.append(v), self.vals.append(a)
        self.rhs.append(rhs)

    def ge(self, terms, rhs):
        self.le([(v, -a) for v, a in terms], -rhs)

    def eq(self, terms, rhs):
        r = len(self.eq_rhs)
        for v, a in terms:
            self.eq_rows.append(r), self.eq_cols.append(v), self.eq_vals.append(a)
        self.eq_rhs.append(rhs)

    def solve(self):
        n = len(self.c)
        A = coo_matrix((self.vals, (self.rows, self.cols)), shape=(len(self.rhs), n)).tocsr() if self.rhs else None
        E = coo_matrix((self.eq_vals, (self.eq_rows, self.eq_cols)), shape=(len(self.eq_rhs), n)).tocsr() if self.eq_rhs else None
        res = linprog(self.c, A_ub=A, b_ub=self.rhs or None, A_eq=E, b_eq=self.eq_rhs or None, bounds=self.bounds, method="highs")
        if res.status != 0:
            raise RuntimeError(f"LP failed: {res.message}")
        return res


def state_of(obs):
    return {"t": obs["month"], "owned": dict(obs["owned"]), "cash": obs["cash"], "launched": obs["launched"],
            "vendor": [q for q in obs["queue"] if q.get("src", "vendor") == "vendor"],
            "broker": [q for q in obs["queue"] if q.get("src", "vendor") != "vendor"],
            "power": obs["power"], "contracts": obs["contracts"],
            "done": obs["window_training"]}


def mv(gen, k, L):
    if gen == "H":
        return W.GPU_PRICE["H"] * 0.98 ** k * (W.LAUNCH_MV if k >= L else 1.0)
    return W.GPU_PRICE["N"] * 0.98 ** max(0, k - L) if k >= L else W.GPU_PRICE["N"]


def solve(state, paths, weights=None, lead=6, shortfall=40.0, margin=0.0, shared=0):
    """paths: list of dicts with per-month arrays indexed by absolute month (see oracle_path / Bayes.sample_path).
    Decisions for months t..t+shared are common to all paths (non-anticipative: they can't depend on which future
    comes true); later decisions may differ per path. Returns (first-month decisions, objective, per-path spot now)."""
    t = state["t"]
    S = len(paths)
    weights = weights or [1.0 / S] * S
    m = Model()
    gen_now = "N" if state["launched"] else "H"
    def decisions(k):
        return {"buy": m.var(), "rH": m.var(ub=W.RESELL_CAP), "rN": m.var(ub=W.RESELL_CAP), "pw": m.var(),
                **{f"res{x}": m.var() for x in TERMS},
                **{f"b{b}": m.var(ub=W.BROKER_CAP if k <= T - 3 else 0.0) for b in W.BROKERS}}
    common = {k: decisions(k) for k in range(t, min(T, t + shared + 1))}
    first = common[t]
    spot_now = []
    months = range(t, T)
    for p, w in zip(paths, weights):
        L = p["L"]
        gen = {k: ("N" if k >= L else "H") for k in months}
        V = {}
        for k in months:
            V[k] = {**(common[k] if k in common else decisions(k)),
                    "dH": m.var(ub=p["alloc"]["H"][k]), "dN": m.var(ub=p["alloc"]["N"][k]),
                    "OH": m.var(), "ON": m.var(), "cH": m.var(), "cN": m.var(),
                    "s": m.var(ub=p["scap"][k]), "served": m.var(ub=p["D"][k]), "tr": m.var(),
                    "cash": m.var(lb=None), "debt": m.var()}
        if gen_now == "H" and L <= t:
            raise ValueError("path launch month must be after the current month when gen N is not yet launched")
        # gen of the shared first-month buy follows reality; later buys follow the path's launch month
        gen[t] = gen_now
        for k in months:
            v = V[k]
            price = W.GPU_PRICE[gen[k]]
            mark_k = {g: W.RESALE * mv(g, k, L) for g in ("H", "N")}
            # objective (weighted)
            m.c[v["buy"]] += w * price
            for b, mu in W.BROKERS.items():
                q = p["bq"][b][min(k + 1, T - 1)]
                m.c[v[f"b{b}"]] += w * price * mu * (1 - W.BROKER_REFUND * (1 - q))
            for x in TERMS:
                m.c[v[f"res{x}"]] += w * p["cidx"][k] * W.TERM_FACTOR[x] * x
            m.c[v["pw"]] += w * W.POWER_COST * W.POWER_TERM
            m.c[v["s"]] += w * p["sprice"][k]
            m.c[v["served"]] -= w * W.UNSERVED_INFERENCE          # (D - served) * 4, constant dropped
            m.c[v["rH"]] -= w * mark_k["H"]
            m.c[v["rN"]] -= w * mark_k["N"]
            m.c[v["debt"]] += w * W.RATE
            # buys only in the right generation
            if gen[k] == "H":
                pass
            # owned during month k (after this month's resales)
            def arrivals(g, j):   # GPUs of gen g that become usable at the start of month j+1
                terms = [(V[j]["dH" if g == "H" else "dN"], 1.0)]
                if j - 1 >= t:
                    for b in W.BROKERS:
                        if gen[j - 1] == g:
                            terms.append((V[j - 1][f"b{b}"], p["bq"][b][j]))
                return terms, sum(o["ordered"] * p["bq"][o["src"]][j] for o in state["broker"] if o["gen"] == g and o["placed"] + 1 == j)
            for g in ("H", "N"):
                O = v["O" + g]
                if k == t:
                    m.eq([(O, 1.0), (v["r" + g], 1.0)], state["owned"][g])
                else:
                    terms, const = arrivals(g, k - 1)
                    m.eq([(O, 1.0), (V[k - 1]["O" + g], -1.0), (v["r" + g], 1.0)] + [(x, -a) for x, a in terms], const)
            m.le([(v["cH"], 1.0), (v["OH"], -1.0)], 0.0)
            m.le([(v["cN"], 1.0), (v["ON"], -1.0)], 0.0)
            # power
            mw_exist = sum(x["mw"] for x in state["power"] if x["start"] <= k < x["end"])
            new_pw = [(V[j]["pw"], 1.0) for j in range(t, k + 1) if j + lead <= k < j + lead + W.POWER_TERM]
            m.le([(v["cH"], W.POWER_MW["H"]), (v["cN"], W.POWER_MW["N"])] + [(x, -1.0) for x, _ in new_pw], mw_exist)
            # reservations
            res_exist = sum(c["qty"] for c in state["contracts"] if c["start"] <= k < c["end"])
            new_res = [(V[j][f"res{x}"], 1.0) for x in TERMS for j in range(t, k) if j + 1 <= k < j + 1 + x]
            m.le([(v[f"res{x}"], 1.0) for x in TERMS], p["rcap"][k])
            # capacity balance: compute + reserved + spot >= served + training
            m.ge([(v["cH"], 1.0), (v["cN"], W.COMPUTE["N"]), (v["s"], 1.0), (v["served"], -1.0), (v["tr"], -1.0)] + new_res, -res_exist)
            # vendor deliveries limited by eligible orders (cumulative, FIFO within a generation)
            for g in ("H", "N"):
                existing = sum(o["left"] for o in state["vendor"] if o["gen"] == g and o["placed"] + W.MIN_LEAD - 1 <= k)
                buys = [(V[j]["buy"], -1.0) for j in range(t, k + 1) if gen[j] == g and j + W.MIN_LEAD - 1 <= k]
                m.le([(V[j]["d" + g], 1.0) for j in range(t, k + 1)] + buys, existing)
            if gen[k] == "H":
                for b in W.BROKERS:
                    pass
            # cash flow: purchases within the credit line, then running charges, refunds, interest, funding
            capex = [(v["buy"], price)] + [(v[f"b{b}"], price * mu) for b, mu in W.BROKERS.items()]
            resale = [(v["rH"], mark_k["H"]), (v["rN"], mark_k["N"])]
            cash_in = [(v["cash"], 1.0)]
            m.ge(cash_in + [(x, -a) for x, a in capex] + resale, -W.CREDIT)
            charges_const = W.POWER_COST * mw_exist + sum(c["qty"] * c["price"] for c in state["contracts"] if c["start"] <= k < c["end"])
            charges = [(x, W.POWER_COST) for x, _ in new_pw] + [(v["s"], p["sprice"][k])] + \
                [(V[j][f"res{x}"], p["cidx"][j] * W.TERM_FACTOR[x]) for x in TERMS for j in range(t, k) if j + 1 <= k < j + 1 + x]
            refunds = []
            if k - 1 >= t:
                for b, mu in W.BROKERS.items():
                    refunds.append((V[k - 1][f"b{b}"], W.GPU_PRICE[gen[k - 1]] * mu * W.BROKER_REFUND * (1 - p["bq"][b][k])))
            refund_const = sum(W.BROKER_REFUND * o.get("paid", 0.0) * (1 - p["bq"][o["src"]][k]) for o in state["broker"] if o["placed"] + 1 == k)
            end = cash_in + [(x, -a) for x, a in capex] + resale + [(x, -a) for x, a in charges] + refunds
            # debt >= -(end-of-month cash)
            m.ge([(v["debt"], 1.0)] + end, charges_const - refund_const)
            if k + 1 < T:
                # cash(k+1) = end - interest + funding
                m.eq([(V[k + 1]["cash"], 1.0), (v["debt"], W.RATE)] + [(x, -a) for x, a in end],
                     W.FUNDING - charges_const + refund_const)
            else:
                pass
            if k == t:
                m.eq([(v["cash"], 1.0)], state["cash"])
                spot_now.append(v["s"])
        # training windows
        for (a, d, target), done in zip(W.MILESTONES, state["done"]):
            if d < t:
                continue
            slack = m.var(cost=w * shortfall)
            m.ge([(V[k]["tr"], 1.0) for k in range(max(a, t), d + 1)] + [(slack, 1.0)], target * (1 + margin) - done)
        # settlement mark: owned at the end plus undelivered vendor orders, at resale value
        k = T - 1
        for g in ("H", "N"):
            val = W.RESALE * mv(g, T, L)
            m.c[V[k]["O" + g]] -= w * val
            terms, _ = arrivals(g, k)
            for x, a in terms:
                m.c[x] -= w * val * a
            # undelivered = ordered - delivered
            for j in months:
                if gen[j] == g:
                    m.c[V[j]["buy"]] -= w * val
                m.c[V[j]["d" + g]] += w * val
    res = m.solve()
    x = res.x
    dec = {key: float(x[i]) for key, i in first.items()}
    dec["gen"] = gen_now
    return dec, float(res.fun), [float(x[i]) for i in spot_now]


def oracle_path(w):
    """The true future of World w as an LP path."""
    alloc = {g: [W.ALLOC[g][w.regime[k]] * w.alloc_noise[k][g] * (W.EXPORT_ALLOC if g == "H" and w.export_active(k) else 1.0)
                 for k in range(T)] for g in ("H", "N")}
    alloc["N"] = [a if k >= w.launch else 0.0 for k, a in enumerate(alloc["N"])]
    return {"L": w.launch, "alloc": alloc, "D": list(w.demand),
            "scap": [W.SPOT_CAP[w.regime[k]] * (0.5 if w.spike[k] else 1.0) * (W.EXPORT_SPOT if w.export_active(k) else 1.0) for k in range(T)],
            "sprice": [w.spot_price(k) for k in range(T)], "cidx": w.cindex[:T],
            "rcap": [W.RESERVE_CAP[w.regime[k]] for k in range(T)],
            "bq": {b: [w.broker_q(b, k) for k in range(T)] for b in W.BROKERS}}


def oracle(seed, lead=W.POWER_LEAD[0]):
    """Perfect-information LP bound on net cost (relaxation; see module docstring)."""
    w = W.World(seed)
    dec, obj, _ = solve(state_of(w.observe()), [oracle_path(w)], lead=lead, shortfall=W.SHORTFALL_COST)
    # constants the LP dropped: unserved demand at full value, existing contracts and power over the horizon
    const = W.UNSERVED_INFERENCE * sum(w.demand)
    const += sum(c["qty"] * c["price"] * (c["end"] - max(c["start"], 0)) for c in w.contracts)
    const += sum(p["mw"] * W.POWER_COST * (p["end"] - max(p["start"], 0)) for p in w.power)
    return obj + const
