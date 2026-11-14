"""Scripted policy ladder for GPU World.

Every policy except `oracle` and `clairvoyant` sees only World.observe() and the documented rules
(the constants in world.py, which TASK.md states), and acts through the same text commands the agent uses.

- reference (`LPPolicy`): Bayesian filter over every hidden factor, then each month an LP over 12 futures
  sampled from the posterior (sample-average approximation); plays the first month's decisions.
- oracle (`OracleMPC`): the same LP on the true future. Perfect information; an upper bound in practice.
- heuristic (`Reference`): the earlier hand-written planner on the same Bayesian filter.
- clairvoyant: the heuristic given the truth (kept for comparison).
"""
import math
import random

import lp
import world as W
from world import T, MILESTONES


def play(policy, seed, stop_after=None):
    w = W.World(seed)
    act = w.command
    pol = policy(w) if getattr(policy, "needs_world", False) else policy()
    while w.t < W.T:
        if stop_after is None or w.t < stop_after:
            try:
                pol(w.observe(), act)
            except ValueError:
                pass
        w.end_month()
    return w.settlement


def do_nothing():
    return lambda obs, act: None


class SpotOnly:
    """Myopic: never buys hardware; rents this month's gap on spot, reserves 6 months when spot is dearer."""

    def __call__(self, obs, act):
        t = obs["month"]
        d = obs["history"][-1]["inference_demand"] * 1.05 if obs["history"] else 4.2
        need = next(((tg - done) / (d - t + 1) for (a, d, tg), done in zip(MILESTONES, obs["window_training"]) if a <= t <= d), 0)
        _, own = powered_compute(obs, t)
        res = sum(c["qty"] for c in obs["contracts"] if c["start"] <= t < c["end"])
        gap = d + max(0, need) - own - res
        p = obs["prices"]
        if gap > 0 and p["spot"] > p["reserve"][6] and t + 7 <= T:
            res_next = sum(c["qty"] for c in obs["contracts"] if c["start"] <= t + 1 < c["end"])
            if d + max(0, need) - own - res_next > 0.5:
                act(f"reserve {d + max(0, need) - own - res_next:.2f} 6")
        act(f"set_spot {max(0, gap):.2f}")


def powered_compute(obs, k, owned=None):
    owned = owned or obs["owned"]
    mw = sum(p["mw"] for p in obs["power"] if p["start"] <= k < p["end"])
    n = min(owned["N"], mw / W.POWER_MW["N"])
    h = min(owned["H"], (mw - n * W.POWER_MW["N"]) / W.POWER_MW["H"])
    return mw, h * W.COMPUTE["H"] + n * W.COMPUTE["N"]


# ---------------------------------------------------------------- beliefs
class Bayes:
    """Filters the supply regime and the launch month from what the player sees."""

    def __init__(self):
        self.b = 0.5                       # P(tight) for the current month
        self.launch = {m: 1.0 for m in range(W.LAUNCH_RANGE[0], W.LAUNCH_RANGE[1] + 1)}
        self.pending = None                # (month, eligible-by-gen, export_active) for shipment evidence
        self.export_start = None
        self.export_rumour = -99
        self.seen = -1
        self.last_index = None
        self.rel = {b: 0.5 for b in W.BROKERS}   # P(broker reliable) at the last month seen

    def update(self, obs):
        t = obs["month"]
        if t == self.seen:
            return
        self.seen = t
        hist = obs["history"]
        if self.pending and hist:
            k, elig, exp = self.pending
            sh = hist[-1]["shipped"]
            for g in ("H", "N"):
                if elig[g] > sh[g] + 1e-6:      # allocation was binding: shipped amount reveals it
                    f = W.EXPORT_ALLOC if g == "H" and exp else 1.0
                    like = {r: (1 / (0.6 * W.ALLOC[g][r] * f)) if 0.7 * W.ALLOC[g][r] * f - 1e-6 <= sh[g] <= 1.3 * W.ALLOC[g][r] * f + 1e-6 else 1e-3
                            for r in ("loose", "tight")}
                    self._bayes(like["tight"], like["loose"])
        if t > 0:
            self.b = self.b * (1 - W.SWITCH) + (1 - self.b) * W.SWITCH
        if hist:   # broker outcomes resolved at the end of last month, then the silent-decay hazard into this month
            for e in hist[-1]["broker"]:
                r = self.rel[e["src"]]
                lr, lu = (W.BROKER_Q["reliable"], W.BROKER_Q["unreliable"]) if e["delivered"] else \
                    (1 - W.BROKER_Q["reliable"], 1 - W.BROKER_Q["unreliable"])
                self.rel[e["src"]] = r * lr / (r * lr + (1 - r) * lu)
            for b in self.rel:
                self.rel[b] *= 1 - decay_hazard(t)
        news = obs["news"]
        for n in news:
            if n in W.BEARISH:
                self._bayes(W.HEADLINE_ACC, 1 - W.HEADLINE_ACC)
            elif n in W.BULLISH:
                self._bayes(1 - W.HEADLINE_ACC, W.HEADLINE_ACC)
            elif n.startswith("Sources: new accelerator export"):
                self.export_rumour = t
            elif n.startswith("Export controls take effect"):
                self.export_start = t
        spike = any(n.startswith("Rival lab") for n in news)
        ratio = obs["prices"]["spot"] / obs["prices"]["reserve"][12] / (1.5 if spike else 1.0)
        lp = {r: math.exp(-0.5 * ((math.log(ratio) - math.log(W.SPOT_MULT[r])) / W.SPOT_NOISE) ** 2) for r in ("loose", "tight")}
        self._bayes(lp["tight"], lp["loose"])
        # last month's contract-index drift is evidence about last month's regime (skip the launch month's step)
        c = obs["prices"]["reserve"][12]
        if self.last_index and not (obs["launched"] and self.launch == {t: 1.0}):
            d = math.log(c / self.last_index)
            ld = {r: math.exp(-0.5 * ((d - math.log(W.DRIFT[r])) / W.DRIFT_NOISE) ** 2) for r in ("loose", "tight")}
            lt = (1 - W.SWITCH) * ld["tight"] + W.SWITCH * ld["loose"]   # regime may have switched since
            ll = (1 - W.SWITCH) * ld["loose"] + W.SWITCH * ld["tight"]
            self._bayes(lt, ll)
        self.last_index = c
        # launch month
        if obs["launched"]:
            if len(self.launch) > 1:
                self.launch = {t: 1.0}
        else:
            for m in list(self.launch):
                if m <= t:
                    self.launch[m] = 0.0
            confirm = any(n.startswith("Vendor confirms") for n in news)
            if t + 1 in self.launch:
                for m in self.launch:
                    self.launch[m] *= (0.8 if m == t + 1 else 0.0) if confirm else (0.2 if m == t + 1 else 1.0)
            for n in news:
                if n.startswith("Supply-chain sources"):
                    x = int(n.split("month ")[1].rstrip("."))
                    for m in self.launch:
                        self.launch[m] *= 1.0 if abs(m - x) <= 2 else 0.0
            z = sum(self.launch.values()) or 1.0
            self.launch = {m: v / z for m, v in self.launch.items()}

    def _bayes(self, lt, ll):
        self.b = self.b * lt / (self.b * lt + (1 - self.b) * ll)

    def p_tight(self, k, t):
        return 0.5 + (self.b - 0.5) * (1 - 2 * W.SWITCH) ** (k - t)

    def launch_quantile(self, q):
        acc = 0.0
        for m in sorted(self.launch):
            acc += self.launch[m]
            if acc >= q - 1e-9:
                return m
        return max(self.launch)

    def export_factor(self, k, t):
        if self.export_start is not None:
            return W.EXPORT_ALLOC if self.export_start <= k < self.export_start + W.EXPORT_MONTHS else 1.0
        return W.EXPORT_ALLOC if t - self.export_rumour <= 2 and t <= k < t + 2 + W.EXPORT_MONTHS else 1.0

    def broker_q(self, b, k, t):
        r = self.rel[b]
        for j in range(t + 1, k + 1):
            r *= 1 - decay_hazard(j)
        return r * W.BROKER_Q["reliable"] + (1 - r) * W.BROKER_Q["unreliable"]

    def demand(self, obs, k):
        level, g, n = self.demand_fit(obs)
        return level * math.exp(g * (k - n + 1))

    def demand_fit(self, obs, halflife=4.0):
        """Exponentially weighted log-linear trend: recent months dominate, so a silent growth switch shows up.
        Returns (fitted level at the last observed month, growth per month, months observed)."""
        d = [h["inference_demand"] for h in obs["history"]]
        n = len(d)
        g = 0.05
        if n >= 3:
            w = [0.5 ** ((n - 1 - i) / halflife) for i in range(n)]
            sw = sum(w)
            mx = sum(wi * i for wi, i in zip(w, range(n))) / sw
            my = sum(wi * math.log(v) for wi, v in zip(w, d)) / sw
            sxx = sum(wi * (i - mx) ** 2 for wi, i in zip(w, range(n)))
            g_hat = sum(wi * (i - mx) * (math.log(v) - my) for wi, i, v in zip(w, range(n), d)) / sxx
            g = min(0.1, max(0.0, (g_hat * sxx + 0.05 * 2) / (sxx + 2)))
            base = math.exp(my + g * (n - 1 - mx))
        else:
            base = d[-1] if d else 6.0 * math.exp(-0.05)
        return base, g, n

    def sample_path(self, obs, rng):
        """One future drawn from the posterior (plus the documented noise models), as an lp path."""
        t = obs["month"]
        reg, tight = {}, rng.random() < self.b
        for k in range(t, T):
            if k > t and rng.random() < W.SWITCH:
                tight = not tight
            reg[k] = "tight" if tight else "loose"
        if obs["launched"]:
            L = next(iter(self.launch))
        else:
            ms, ps = zip(*self.launch.items())
            L = rng.choices(ms, ps)[0]
        if self.export_start is not None:
            ex = set(range(self.export_start, self.export_start + W.EXPORT_MONTHS))
        else:
            fut = [m for m in range(max(t, 5), 16)]
            past = len([m for m in range(5, t)])
            p_future = 0.7 if t - self.export_rumour <= 1 and fut else (0.5 * len(fut) / 11) / (1 - 0.5 * past / 11) if fut else 0.0
            if fut and rng.random() < p_future:
                st = rng.choice([m for m in fut if m <= t + 2] or fut) if t - self.export_rumour <= 1 else rng.choice(fut)
                ex = set(range(st, st + W.EXPORT_MONTHS))
            else:
                ex = set()
        news_spike = any(n.startswith("Rival lab") for n in obs["news"])
        spike = {k: (news_spike if k == t else rng.random() < W.SPIKE_P) for k in range(t, T)}
        c = {t: obs["prices"]["reserve"][12]}
        for k in range(t + 1, T):
            c[k] = c[k - 1] * W.DRIFT[reg[k - 1]] * math.exp(rng.gauss(0, W.DRIFT_NOISE)) * (W.LAUNCH_PRICE if k == L else 1.0)
            c[k] = min(4.0, max(0.8, c[k]))
        sprice = {k: (obs["prices"]["spot"] if k == t else
                      c[k] * W.SPOT_MULT[reg[k]] * math.exp(rng.gauss(0, W.SPOT_NOISE)) * (1.5 if spike[k] else 1.0)) for k in range(t, T)}
        level, g_hat, n = self.demand_fit(obs)
        wts = [math.exp(-0.5 * ((g_hat - g) / 0.015) ** 2) for g in W.GROWTH]
        g = rng.choices(W.GROWTH, wts)[0]
        lo, hi = W.GROWTH_SWITCH_RANGE
        fut = [m for m in range(max(t, lo), hi + 1)]
        past = len(range(lo, max(lo, t)))
        sw = None
        if fut and rng.random() < (W.GROWTH_SWITCH_P * len(fut) / (hi - lo + 1)) / (1 - W.GROWTH_SWITCH_P * past / (hi - lo + 1)):
            sw = rng.choice(fut)
        D, lvl = {}, math.log(level)
        for k in range(n, T):
            lvl += (W.GROWTH[1] if g == W.GROWTH[0] else W.GROWTH[0]) if sw is not None and k > sw else g
            if k >= t:
                D[k] = math.exp(lvl + rng.gauss(0, 0.05))
        bq = {}
        for b in W.BROKERS:
            rel = rng.random() < self.rel[b]
            bq[b] = {}
            for k in range(t, T):
                if rel and k > t and rng.random() < decay_hazard(k):
                    rel = False
                bq[b][k] = W.BROKER_Q["reliable" if rel else "unreliable"]
        alloc = {g_: {k: (W.ALLOC[g_][reg[k]] * rng.uniform(0.7, 1.3) * (W.EXPORT_ALLOC if g_ == "H" and k in ex else 1.0)
                          if g_ == "H" or k >= L else 0.0) for k in range(t, T)} for g_ in ("H", "N")}
        return {"L": L, "alloc": alloc, "D": D, "cidx": c, "sprice": sprice, "bq": bq,
                "scap": {k: W.SPOT_CAP[reg[k]] * (0.5 if spike[k] else 1.0) * (W.EXPORT_SPOT if k in ex else 1.0) for k in range(t, T)},
                "rcap": {k: W.RESERVE_CAP[reg[k]] for k in range(t, T)}}


def decay_hazard(k):
    """P(a still-reliable broker turns unreliable at month k), from the documented prior."""
    lo, hi = W.BROKER_DECAY_RANGE
    if not lo <= k <= hi:
        return 0.0
    per = W.BROKER_DECAY_P / (hi - lo + 1)
    return per / (1 - per * (k - lo))


class Truth:
    """The hidden future, for the clairvoyant upper bound."""

    def __init__(self, w):
        self.w = w

    def update(self, obs):
        pass

    def p_tight(self, k, t):
        return 1.0 if self.w.regime[min(k, T - 1)] == "tight" else 0.0

    def launch_quantile(self, q):
        return self.w.launch

    def export_factor(self, k, t):
        return W.EXPORT_ALLOC if self.w.export_active(k) else 1.0

    def demand(self, obs, k):
        return self.w.demand[min(k, T - 1)]

    def broker_q(self, b, k, t):
        return self.w.broker_q(b, min(k, T - 1))


# ---------------------------------------------------------------- reference planner
class Reference:
    """Bayesian regime/launch estimate + expected-cost hedging, replanned every month.

    Plans capacity for every future month in cost order: owned GPUs (H before the
    launch, N after, bought only when they arrive in time to be used long enough),
    then reserved contracts started early enough given the monthly reservation cap,
    then spot. Power is kept ahead of the projected fleet at the worst-case lead time.
    Before the launch it counts on gen N only from a late launch quantile.
    """
    P = {"m_inf": 0.08, "m_tr": 0.05, "pess": 0.0, "alloc_q": 0.85, "use_h": 8, "use_n": 4,
         "launch_q": 0.75, "n_share": 0.8, "spot_share": 0.6, "queue_months": 2, "spot_buf": 0.05, "rent_mult": 1.5,
         "probe": 0.5, "cash_months": 2}

    def __init__(self, beliefs=None, **params):
        self.bel = beliefs or Bayes()
        self.p = {**self.P, **params}

    def alloc(self, g, k, t, pess):
        q = min(1.0, self.bel.p_tight(k, t) + pess)
        a = W.ALLOC[g]["loose"] * (1 - q) + W.ALLOC[g]["tight"] * q
        return a * (self.p["alloc_q"] if pess else 1.0) * (self.bel.export_factor(k, t) if g == "H" else 1.0)

    def mix(self, table, k, t):
        q = self.bel.p_tight(k, t)
        return table["loose"] * (1 - q) + table["tight"] * q

    def project(self, obs, pess=0.0):
        """Owned GPUs by generation at the start of each month k in t..T-1 under projected allocation."""
        t = obs["month"]
        owned = dict(obs["owned"])
        queue = [dict(q) for q in obs["queue"] if q.get("src", "vendor") == "vendor"]
        brokers = [q for q in obs["queue"] if q.get("src", "vendor") != "vendor"]
        out = {}
        for k in range(t, T):
            out[k] = dict(owned)
            for q in brokers:     # a broker order is confirmed at the end of month placed+1
                if q["placed"] + 1 == k:
                    owned[q["gen"]] += q["ordered"] * self.bel.broker_q(q["src"], k, t)
            for g in ("H", "N"):
                a = self.alloc(g, k, t, pess)
                for q in queue:
                    if q["gen"] == g and q["left"] > 0 and k >= q["placed"] + W.MIN_LEAD - 1 and a > 0:
                        s = min(q["left"], a)
                        q["left"] -= s
                        a -= s
                        owned[g] += s
        return out

    def targets(self, obs):
        t = obs["month"]
        rate = {}
        for (a, d, tg), done in zip(MILESTONES, obs["window_training"]):
            for k in range(max(a, t), d + 1):
                rate[k] = max(0.0, tg - done) / (d - max(a, t) + 1)
        return {k: self.bel.demand(obs, k) * (1 + self.p["m_inf"]) + rate[k] * (1 + self.p["m_tr"]) for k in range(t, T)}

    def planned_n(self, obs, k):
        """gen N compute we expect to own by month k from orders not yet placed (before the launch)."""
        t = obs["month"]
        if obs["launched"]:
            return 0.0
        start = self.bel.launch_quantile(self.p["launch_q"]) + W.MIN_LEAD
        return self.p["n_share"] * W.COMPUTE["N"] * sum(self.alloc("N", j, t, 0.0) for j in range(start - 1, k))

    def owning_pays(self, obs, gen, k, price=None):
        """Expected cost per kH-month of owning from month k to the end vs renting (12-month contract) then.
        Owning bought on credit also carries interest (about half the holding period, on average)."""
        t = obs["month"]
        u = T - k
        price = price or W.GPU_PRICE[gen]
        mv_end = W.GPU_PRICE["H"] * 0.98 ** T * W.LAUNCH_MV if gen == "H" else \
            W.GPU_PRICE["N"] * 0.98 ** max(0, T - self.bel.launch_quantile(0.5))
        own = ((price - W.RESALE * mv_end) / u + W.POWER_MW[gen] * W.POWER_COST) / W.COMPUTE[gen]
        if obs["cash"] < price:
            own += W.RATE * price * 0.5 / W.COMPUTE[gen]
        rent = obs["prices"]["reserve"][12]
        for j in range(t, k):
            q = self.bel.p_tight(j, t)
            rent *= W.DRIFT["tight"] * q + W.DRIFT["loose"] * (1 - q)
        if not obs["launched"] and self.bel.launch_quantile(0.5) <= k:
            rent *= W.LAUNCH_PRICE
        return own < rent * self.p["rent_mult"]

    @staticmethod
    def reserved(obs, k):
        return sum(c["qty"] for c in obs["contracts"] if c["start"] <= k < c["end"])

    @staticmethod
    def compute(owned):
        return sum(owned[g] * W.COMPUTE[g] for g in owned)

    def headroom(self, obs):
        """Cash we can still commit to hardware, keeping a few months of running charges in reserve."""
        t = obs["month"]
        running = sum(x["mw"] for x in obs["power"] if x["start"] <= t < x["end"]) * W.POWER_COST + \
            sum(c["qty"] * c["price"] for c in obs["contracts"] if c["start"] <= t < c["end"]) + \
            obs["spot_level"] * obs["prices"]["spot"]
        return obs["cash"] + W.CREDIT - self.p["cash_months"] * running

    def __call__(self, obs, act):
        self.bel.update(obs)
        t, p = obs["month"], self.p
        cap = self.targets(obs)

        def add(key, item):
            nonlocal obs
            obs = obs | {key: obs[key] + [item]}

        def buy(qty, gen, src="vendor"):
            nonlocal obs
            unit = W.GPU_PRICE[gen] * (W.BROKERS[src] if src in W.BROKERS else 1.0)
            qty = min(qty, self.headroom(obs) / unit)
            if qty > 0.25:
                act(f"buy_gpus {qty:.2f} {gen} {src}")
                add("queue", {"gen": gen, "left": qty, "placed": t, "ordered": qty, "id": -1, "src": src})
                obs = obs | {"cash": obs["cash"] - qty * unit}

        # 1. hardware: order for month k only once waiting another month would make it late (pessimistic allocation)
        gen = "N" if obs["launched"] else "H"
        last = T - p["use_n" if gen == "N" else "use_h"]
        if t + W.MIN_LEAD <= last:
            proj = self.project(obs, pess=p["pess"])
            q = 0.0
            for k in range(t + W.MIN_LEAD, last + 1):
                g = (cap[k] - self.compute(proj[k]) - self.reserved(obs, k) - self.planned_n(obs, k)) / W.COMPUTE[gen]
                if g <= q + 0.25 or not self.owning_pays(obs, gen, k):
                    continue
                now = self.project(obs | {"queue": obs["queue"] + [{"gen": gen, "left": g, "placed": t}]}, pess=p["pess"])
                later = self.project(obs | {"queue": obs["queue"] + [{"gen": gen, "left": g, "placed": t + 1}]}, pess=p["pess"])
                arrive = now[k][gen] - proj[k][gen]              # what an order placed now delivers by month k
                if later[k][gen] - proj[k][gen] < arrive - 1e-6:  # waiting a month would deliver less in time
                    q = max(q, arrive)
            # tranches: a queue holding a few months of loose-regime allocation never wastes a shipment,
            # and later orders can use what the coming months reveal
            queued = sum(x["left"] for x in obs["queue"] if x["gen"] == gen and x.get("src", "vendor") == "vendor")
            buy(min(q, 30.0, p["queue_months"] * W.ALLOC[gen]["loose"] - queued), gen)
        # 1b. brokers: one small probe each at the start (their reliability is only learned by ordering),
        #     then just-in-time top-ups for month t+2, from the broker with the lowest expected cost per delivered GPU
        if t == 0:
            for b in W.BROKERS:
                buy(p["probe"], gen, b)
        k = t + 2
        if k < T - 2:
            proj = self.project(obs, pess=p["pess"])
            gap = (cap[k] - self.compute(proj[k]) - self.reserved(obs, k) - self.planned_n(obs, k)) / W.COMPUTE[gen]

            def eff(b):   # expected outlay per delivered GPU (failed orders refund 80%)
                q = self.bel.broker_q(b, t + 1, t)
                return W.GPU_PRICE[gen] * W.BROKERS[b] * (q + (1 - W.BROKER_REFUND) * (1 - q)) / q
            for b in sorted(W.BROKERS, key=eff):
                if gap <= 0.25 or not self.owning_pays(obs, gen, k, eff(b)):
                    break
                q = self.bel.broker_q(b, t + 1, t)
                n = min(W.BROKER_CAP - (p["probe"] if t == 0 else 0.0), gap / q)
                buy(n, gen, b)
                gap -= n * q
        # 2. power: keep MW ahead of the projected fleet (incl. planned gen N); before the worst-case lead
        #    time, count contracts already signed as if they will be on in time
        proj = self.project(obs)
        worst = 0.0
        pending = sum(x["mw"] for x in obs["power"] if x["start"] > t)
        for k in range(t + W.POWER_LEAD[0], T):
            mw = sum(x["mw"] for x in obs["power"] if x["start"] <= k < x["end"]) + (
                sum(x["mw"] for x in obs["power"] if x["start"] > k) if k < t + W.POWER_LEAD[1] else 0.0)
            want = sum(proj[k][g] * W.POWER_MW[g] for g in ("H", "N")) + self.planned_n(obs, k) / W.COMPUTE["N"] * W.POWER_MW["N"]
            worst = max(worst, want - mw)
        if worst > 0.5:
            act(f"contract_power {min(100.0, worst * 1.03):.1f}")
            add("power", {"mw": worst * 1.03, "start": t + W.POWER_LEAD[1], "end": t + W.POWER_LEAD[1] + W.POWER_TERM})
        # 3. reservations: start early enough that the monthly cap still covers every future residual gap
        rc = self.mix(W.RESERVE_CAP, t, t)
        resid = {k: cap[k] - powered_compute(obs, k, proj[k])[1] - self.reserved(obs, k) - self.planned_n(obs, k)
                 - p["spot_share"] * self.mix(W.SPOT_CAP, k, t) for k in range(t + 1, T)}
        need = {k: r - rc * (k - t - 1) for k, r in resid.items() if r > 0.3}
        if need:
            x = max(need.values())
            if x > 0.3:
                far = max(k for k, v in need.items() if v > 0.3)
                launch_soon = not obs["launched"] and self.bel.launch_quantile(0.5) <= t + 7
                # a term may run past month 23 (the tail is a priced obligation, cheaper than a missed run)
                long_ok = t + 13 <= T and not launch_soon and sum(resid.get(k, 0) > 0.3 for k in range(t + 1, t + 13)) >= 10
                term = 12 if long_ok or far >= t + 7 else 6
                if term:
                    act(f"reserve {x:.2f} {term}")
                    add("contracts", {"qty": min(x, rc), "price": 0, "start": t + 1, "end": t + 1 + term})
        # 4. spot: whatever is still short this month
        gap_now = cap[t] - powered_compute(obs, t)[1] - self.reserved(obs, t)
        act(f"set_spot {max(0.0, gap_now + p['spot_buf'] * cap[t]):.2f}")   # extra spot is cheap next to a missed run
        if isinstance(self.bel, Bayes):
            elig = {g: sum(q["left"] for q in obs["queue"] if q["gen"] == g and t >= q["placed"] + W.MIN_LEAD - 1) for g in ("H", "N")}
            self.bel.pending = (t, elig, self.bel.export_start is not None and self.bel.export_factor(t, t) < 1.0)


class LPPolicy:
    """Model-predictive control: each month, solve the LP over future paths and play the first month's decisions.

    With posterior samples (`Bayes`) this is the reference; with the single true path it is the perfect-information
    policy. Broker reliability can only be learned by ordering, which the LP does not value, so both probe each
    broker once at the start. The spot request is a high quantile of the per-path optimum (it is cheap insurance)."""
    P = {"paths": 12, "lead": 6, "shortfall": 40.0, "spot_q": 0.75, "probe": 0.5, "margin": 0.06, "shared": 2}

    def __init__(self, beliefs=None, seed=0, **params):
        self.bel = beliefs or Bayes()
        self.p = {**self.P, **params}
        self.rng = random.Random(seed)

    def paths(self, obs):
        if isinstance(self.bel, Truth):
            return [lp.oracle_path(self.bel.w)]
        return [self.bel.sample_path(obs, self.rng) for _ in range(self.p["paths"])]

    def __call__(self, obs, act):
        self.bel.update(obs)
        t, p = obs["month"], self.p

        def do(cmd):
            try:
                act(cmd)
            except ValueError:
                pass
        # exploration: a small order is the only way to learn a broker's reliability (re-probing later
        # to track silent decay cost more than it saved on the training seeds)
        gen = "N" if obs["launched"] else "H"
        for b, mu in W.BROKERS.items():
            if t == 0:
                do(f"buy_gpus {p['probe']} {gen} {b}")
                cost = p["probe"] * W.GPU_PRICE[gen] * mu
                obs = obs | {"cash": obs["cash"] - cost, "queue": obs["queue"] + [
                    {"gen": gen, "ordered": p["probe"], "left": p["probe"], "placed": t, "src": b, "paid": cost}]}
        dec, _, spot = lp.solve(lp.state_of(obs), self.paths(obs), lead=p["lead"], shortfall=p["shortfall"], margin=p["margin"], shared=p["shared"])
        spot = sorted(spot)[min(len(spot) - 1, int(p["spot_q"] * len(spot)))]
        do(f"set_spot {max(0.0, spot):.2f}")
        if dec["buy"] > 0.25:
            do(f"buy_gpus {min(30.0, dec['buy']):.2f} {dec['gen']}")
        for x in sorted(lp.TERMS, key=lambda x: -dec[f"res{x}"]):
            if dec[f"res{x}"] > 0.25:
                do(f"reserve {dec[f'res{x}']:.2f} {x}")
        if dec["pw"] > 0.5:
            do(f"contract_power {min(100.0, dec['pw']):.1f}")
        for b in W.BROKERS:
            if dec[f"b{b}"] > 0.25:
                do(f"buy_gpus {dec[f'b{b}']:.2f} {dec['gen']} {b}")
        for g in ("H", "N"):
            if dec["r" + g] > 0.25:
                do(f"resell_gpus {min(dec['r' + g], obs['owned'][g]):.2f} {g}")


class OracleMPC(LPPolicy):
    """LP-MPC on the true path: perfect information, but it plays in the real world (ops limit, integer effects)."""
    needs_world = True

    def __init__(self, w):
        super().__init__(Truth(w))


class Clairvoyant(Reference):
    needs_world = True

    def __init__(self, w):
        super().__init__(Truth(w), m_inf=0.02, m_tr=0.05, pess=0.0, alloc_q=1.0, n_share=1.0)


class StopEarly(LPPolicy):
    """The reference for the first 3 months, then nothing (played with stop_after=3)."""


class Exploiter(LPPolicy):
    """Reference play plus the obvious hacks: buy-and-flip GPUs, long cheap contracts with
    obligations past the horizon, and a pile of undelivered orders at the end."""

    def __call__(self, obs, act):
        super().__call__(obs, act)
        t = obs["month"]
        try:
            if t == 0:
                act("buy_gpus 10 H")
            for g in ("H", "N"):
                if obs["owned"][g] >= 3:
                    act(f"resell_gpus 3 {g}")
            if t == T - 2:
                act("reserve 3 24")
            if t == T - 1:
                act("buy_gpus 30")
        except ValueError:
            pass


LADDER = {"do_nothing": (do_nothing, None), "stop_early": (StopEarly, 3), "spot_only": (SpotOnly, None),
          "exploiter": (Exploiter, None), "heuristic": (Reference, None),
          "reference": (LPPolicy, None), "oracle": (OracleMPC, None)}


def ladder(seed):
    out = {name: play(pol, seed, stop) for name, (pol, stop) in LADDER.items()}
    out["lp_bound"] = {"net_cost": round(lp.oracle(seed), 2), "milestones_met": None}
    return out
