"""Linear-programming model of GPU World (three sites, moves between them, capacity options).

`solve(state, paths, ...)` minimises expected settled net cost over one or more future paths.
Decisions for months t..t+shared are common to all paths (they cannot depend on which future
comes true); later decisions may differ per path. With the single true path it is the
perfect-information bound (`oracle`) or the oracle's planner; with paths sampled from a
Bayesian posterior it is the planning core of the reference policy.

Relaxations relative to the world: quantities are continuous, the per-month operation limit is
ignored, vendor deliveries may go to any site's orders (the world ships first-in-first-out),
broker orders deliver their expected fraction, and a missed training run costs only its
per-kH-month shortfall (the fixed penalty is dropped). The world serves inference before
training, while the LP may leave inference unserved (at `unserved` per kH-month) to train; a
planner that must not miss a run has to cover that gap itself (see LPPolicy's guard).
"""
from scipy.optimize import linprog
from scipy.sparse import coo_matrix

import world as W
from world import T, SITES

TERMS = (6, 12, 24)
GENS = ("H", "N")
PAIRS = [(a, b) for a in SITES for b in SITES if a != b]
LEAD = {"us": 6, "eu": 7, "ap": 4}   # power lead the planner assumes (actual dates are known once signed)


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
    return {"t": obs["month"], "owned": {s: dict(obs["owned"][s]) for s in SITES}, "cash": obs["cash"], "launched": obs["launched"],
            "vendor": [q for q in obs["queue"] if q.get("src", "vendor") == "vendor"],
            "broker": [q for q in obs["queue"] if q.get("src", "vendor") != "vendor"],
            "power": obs["power"], "contracts": obs["contracts"], "done": obs["window_training"],
            "options": obs.get("options", 0.0), "moves": obs.get("moves", [])}


def mv(gen, k, L):
    if gen == "H":
        return W.GPU_PRICE["H"] * W.DEPR ** k * (W.LAUNCH_MV if k >= L else 1.0)
    return W.GPU_PRICE["N"] * W.DEPR ** max(0, k - L) if k >= L else W.GPU_PRICE["N"]


def solve(state, paths, weights=None, lead=None, shortfall=40.0, margin=0.0, shared=0, unserved=W.UNSERVED_INFERENCE):
    """paths: dicts with per-month data indexed by absolute month (see oracle_path / Bayes.sample_path).
    Returns (first-month decisions keyed like the variables, objective, per-path spot use this month by site)."""
    lead = lead or LEAD
    t = state["t"]
    S = len(paths)
    weights = weights or [1.0 / S] * S
    m = Model()
    gen_now = "N" if state["launched"] else "H"

    def decisions(k):
        d = {"opt": m.var(ub=W.OPTION_CAP)}
        for s in SITES:
            d["buy", s] = m.var()
            d["pw", s] = m.var()
            d["ex", s] = m.var()
            for x in TERMS:
                d["res", x, s] = m.var()
            for b in W.BROKERS:
                d["b", b, s] = m.var(ub=W.BROKER_CAP if k <= T - 3 else 0.0)
            for g in GENS:
                d["r", g, s] = m.var(ub=W.RESELL_CAP)
        for g in GENS:
            for a, b in PAIRS:
                d["mv", g, a, b] = m.var(ub=W.MOVE_CAP)
        return d
    common = {k: decisions(k) for k in range(t, min(T, t + shared + 1))}
    first = common[t]
    spot_now = []
    months = range(t, T)
    for p, w in zip(paths, weights):
        L = p["L"]
        if gen_now == "H" and L <= t:
            raise ValueError("path launch month must be after the current month when gen N is not yet launched")
        gen = {k: ("N" if k >= L else "H") for k in months}
        gen[t] = gen_now
        V = {}
        for k in months:
            v = dict(common[k]) if k in common else decisions(k)
            for s in SITES:
                for g in GENS:
                    v["d", g, s], v["O", g, s], v["c", g, s] = m.var(), m.var(), m.var()
                v["spot", s] = m.var(ub=p["scap"][s][k])
                v["served", s] = m.var(ub=p["D"][s][k])
                v["tr", s] = m.var()
            v["cash"], v["debt"], v["pos"] = m.var(lb=None), m.var(), m.var()
            V[k] = v

        def arrivals(g, s, j):
            """Variables (with coefficients) and a constant: GPUs of gen g that become usable at site s at the start of month j+1."""
            terms = [(V[j]["d", g, s], 1.0)] + [(V[j]["mv", g, a, s], 1.0) for a in SITES if a != s]
            if j - 1 >= t and gen[j - 1] == g:
                terms += [(V[j - 1]["b", b, s], p["bq"][b][j]) for b in W.BROKERS]
            const = sum(o["ordered"] * p["bq"][o["src"]][j] for o in state["broker"]
                        if o["gen"] == g and o["site"] == s and o["placed"] + 1 == j)
            const += sum(x["qty"] for x in state["moves"] if x["gen"] == g and x["to"] == s and x["arrive"] == j + 1)
            return terms, const

        for k in months:
            v = V[k]
            price = W.GPU_PRICE[gen[k]]
            markk = {g: W.RESALE * mv(g, k, L) for g in GENS}
            # objective (weighted)
            m.c[v["opt"]] += w * W.OPTION_PREMIUM
            for s in SITES:
                m.c[v["buy", s]] += w * price
                for b, mu in W.BROKERS.items():
                    q = p["bq"][b][min(k + 1, T - 1)]
                    m.c[v["b", b, s]] += w * price * mu * (1 - W.BROKER_REFUND * (1 - q))
                for x in TERMS:
                    m.c[v["res", x, s]] += w * p["cidx"][k] * W.TERM_FACTOR[x] * W.SITE_PRICE[s] * x
                m.c[v["ex", s]] += w * W.OPTION_STRIKE * W.OPTION_TERM
                m.c[v["pw", s]] += w * W.POWER_COST[s] * W.POWER_TERM
                m.c[v["spot", s]] += w * p["sprice"][k] * W.SITE_PRICE[s]
                m.c[v["served", s]] -= w * unserved        # (D - served) * unserved, constant dropped
                for g in GENS:
                    m.c[v["r", g, s]] -= w * markk[g]
            for g in GENS:
                for a, b in PAIRS:
                    m.c[v["mv", g, a, b]] += w * W.MOVE_COST
            m.c[v["debt"]] += w * W.RATE
            m.c[v["pos"]] -= w * W.EARN
            # caps shared across sites
            for b in W.BROKERS:
                m.le([(v["b", b, s], 1.0) for s in SITES], W.BROKER_CAP)
            for g in GENS:
                m.le([(v["r", g, s], 1.0) for s in SITES], W.RESELL_CAP)
            m.le([(v["mv", g, a, b], 1.0) for g in GENS for a, b in PAIRS], W.MOVE_CAP)
            # options held: cumulative exercises <= options held now + bought since
            m.le([(V[j]["ex", s], 1.0) for j in range(t, k + 1) for s in SITES] + [(V[j]["opt"], -1.0) for j in range(t, k + 1)],
                 state["options"])
            for g in GENS:
                # vendor allocation is shared by every site's orders
                m.le([(v["d", g, s], 1.0) for s in SITES], p["alloc"][g][k])
            for s in SITES:
                for g in GENS:
                    # owned during month k (after this month's resales and departures)
                    O = v["O", g, s]
                    out = [(v["r", g, s], 1.0)] + [(v["mv", g, s, b], 1.0) for b in SITES if b != s]
                    if k == t:
                        m.eq([(O, 1.0)] + out, state["owned"][s][g])
                    else:
                        terms, const = arrivals(g, s, k - 1)
                        m.eq([(O, 1.0), (V[k - 1]["O", g, s], -1.0)] + out + [(x, -a) for x, a in terms], const)
                    m.le([(v["c", g, s], 1.0), (O, -1.0)], 0.0)
                    # vendor deliveries limited by eligible orders to this site
                    existing = sum(o["left"] for o in state["vendor"] if o["gen"] == g and o["site"] == s and o["placed"] + W.MIN_LEAD - 1 <= k)
                    buys = [(V[j]["buy", s], -1.0) for j in range(t, k + 1) if gen[j] == g and j + W.MIN_LEAD - 1 <= k]
                    m.le([(V[j]["d", g, s], 1.0) for j in range(t, k + 1)] + buys, existing)
                # power
                mw_exist = sum(x["mw"] for x in state["power"] if x["site"] == s and x["start"] <= k < x["end"])
                new_pw = [(V[j]["pw", s], 1.0) for j in range(t, k + 1) if j + lead[s] <= k < j + lead[s] + W.POWER_TERM]
                m.le([(v["c", "H", s], W.POWER_MW["H"]), (v["c", "N", s], W.POWER_MW["N"])] + [(x, -1.0) for x, _ in new_pw], mw_exist)
                # reservations (the cap does not apply to exercised options)
                m.le([(v["res", x, s], 1.0) for x in TERMS], p["rcap"][s][k])
                res_exist = sum(c["qty"] for c in state["contracts"] if c["site"] == s and c["start"] <= k < c["end"])
                new_res = [(V[j]["res", x, s], 1.0) for x in TERMS for j in range(t, k) if j + 1 <= k < j + 1 + x]
                new_res += [(V[j]["ex", s], 1.0) for j in range(t, k) if j + 1 <= k < j + 1 + W.OPTION_TERM]
                # capacity balance per site: compute + reserved + spot >= served + training
                m.ge([(v["c", "H", s], 1.0), (v["c", "N", s], W.COMPUTE["N"]), (v["spot", s], 1.0),
                      (v["served", s], -1.0), (v["tr", s], -1.0)] + new_res, -res_exist)
            # cash: purchases within the credit line, then running charges, refunds, interest, funding
            capex = [(v["opt"], W.OPTION_PREMIUM)] + [(v["mv", g, a, b], W.MOVE_COST) for g in GENS for a, b in PAIRS]
            charges, charges_const = [], 0.0
            for s in SITES:
                capex += [(v["buy", s], price)] + [(v["b", b, s], price * mu) for b, mu in W.BROKERS.items()]
                mw_exist = sum(x["mw"] for x in state["power"] if x["site"] == s and x["start"] <= k < x["end"])
                charges_const += W.POWER_COST[s] * mw_exist
                charges += [(V[j]["pw", s], W.POWER_COST[s]) for j in range(t, k + 1) if j + lead[s] <= k < j + lead[s] + W.POWER_TERM]
                charges += [(V[j]["res", x, s], p["cidx"][j] * W.TERM_FACTOR[x] * W.SITE_PRICE[s]) for x in TERMS for j in range(t, k) if j + 1 <= k < j + 1 + x]
                charges += [(V[j]["ex", s], W.OPTION_STRIKE) for j in range(t, k) if j + 1 <= k < j + 1 + W.OPTION_TERM]
                charges += [(v["spot", s], p["sprice"][k] * W.SITE_PRICE[s])]
            charges_const += sum(c["qty"] * c["price"] for c in state["contracts"] if c["start"] <= k < c["end"])
            resale = [(v["r", g, s], markk[g]) for g in GENS for s in SITES]
            refunds = []
            if k - 1 >= t:
                for s in SITES:
                    for b, mu in W.BROKERS.items():
                        refunds.append((V[k - 1]["b", b, s], W.GPU_PRICE[gen[k - 1]] * mu * W.BROKER_REFUND * (1 - p["bq"][b][k])))
            refund_const = sum(W.BROKER_REFUND * o.get("paid", 0.0) * (1 - p["bq"][o["src"]][k]) for o in state["broker"] if o["placed"] + 1 == k)
            cash_in = [(v["cash"], 1.0)]
            m.ge(cash_in + [(x, -a) for x, a in capex] + resale, -W.CREDIT)
            end = cash_in + [(x, -a) for x, a in capex] + resale + [(x, -a) for x, a in charges] + refunds
            # month-end balance = pos - debt (both >= 0; the LP never holds both, since RATE > EARN)
            m.eq([(v["pos"], 1.0), (v["debt"], -1.0)] + [(x, -a) for x, a in end], refund_const - charges_const)
            if k + 1 < T:
                m.eq([(V[k + 1]["cash"], 1.0), (v["debt"], W.RATE), (v["pos"], -W.EARN)] + [(x, -a) for x, a in end],
                     W.FUNDING - charges_const + refund_const)
            if k == t:
                m.eq([(v["cash"], 1.0)], state["cash"])
                spot_now.append({s: v["spot", s] for s in SITES})
        # training windows (training is pooled across sites)
        for (a, d, target), done in zip(W.MILESTONES, state["done"]):
            if d < t:
                continue
            slack = m.var(cost=w * shortfall)
            m.ge([(V[k]["tr", s], 1.0) for k in range(max(a, t), d + 1) for s in SITES] + [(slack, 1.0)], target * (1 + margin) - done)
        # settlement mark: GPUs held at the end (incl. in transit) and undelivered vendor orders, at resale value
        k = T - 1
        for g in GENS:
            val = W.RESALE * mv(g, T, L)
            for s in SITES:
                m.c[V[k]["O", g, s]] -= w * val
                terms, _ = arrivals(g, s, k)
                for x, a in terms:
                    m.c[x] -= w * val * a
                for j in months:
                    if gen[j] == g:
                        m.c[V[j]["buy", s]] -= w * val
                    m.c[V[j]["d", g, s]] += w * val
    res = m.solve()
    x = res.x
    dec = {key: float(x[i]) for key, i in first.items()}
    dec["gen"] = gen_now
    return dec, float(res.fun), [{s: float(x[i]) for s, i in sp.items()} for sp in spot_now]


def oracle_path(w):
    """The true future of World w as an LP path."""
    alloc = {g: [W.ALLOC[g][w.regime[k]] * w.alloc_noise[k][g] * (W.EXPORT_ALLOC if g == "H" and w.export_active(k) else 1.0)
                 for k in range(T)] for g in GENS}
    alloc["N"] = [a if k >= w.launch else 0.0 for k, a in enumerate(alloc["N"])]
    return {"L": w.launch, "alloc": alloc,
            "D": {s: [w.site_demand(s, k) for k in range(T)] for s in SITES},
            "scap": {s: [w.spot_cap(s, k) for k in range(T)] for s in SITES},
            "rcap": {s: [W.RESERVE_CAP[w.regime[k]][s] for k in range(T)] for s in SITES},
            "sprice": [w.spot_price(k) for k in range(T)], "cidx": w.cindex[:T],
            "bq": {b: [w.broker_q(b, k) for k in range(T)] for b in W.BROKERS}}


def oracle(seed):
    """Perfect-information LP bound on net cost (relaxation; see module docstring). Assumes the shortest power leads."""
    w = W.World(seed)
    lead = {s: W.POWER_LEAD[s][0] for s in SITES}
    _, obj, _ = solve(state_of(w.observe()), [oracle_path(w)], lead=lead, shortfall=W.SHORTFALL_COST)
    # constants the LP dropped: unserved demand at full value, existing contracts and power over their terms
    const = W.UNSERVED_INFERENCE * sum(w.demand)
    const += sum(c["qty"] * c["price"] * (c["end"] - max(c["start"], 0)) for c in w.contracts)
    const += sum(p["mw"] * W.POWER_COST[p["site"]] * (p["end"] - max(p["start"], 0)) for p in w.power)
    return obj + const
