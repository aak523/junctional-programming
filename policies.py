"""Scripted policy ladder for GPU World.

Every policy except `clairvoyant` sees only World.observe() and the documented rules
(the constants in world.py, which TASK.md states), and acts through the same text
commands the agent uses. `clairvoyant` additionally reads the hidden future
(regime path, launch month, demand) and is an upper-bound reference only.
"""
import math

import world as W
from world import T, MILESTONES

ARB = {"H": 0.0, "N": 0.0}


def play(policy, seed, stop_after=None):
    w = W.World(seed)
    act = w.command
    pol = policy(w) if policy is Clairvoyant else policy()
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

    def demand(self, obs, k):
        d = [h["inference_demand"] for h in obs["history"]]
        if len(d) < 3:
            g = 0.05
        else:
            n = len(d)
            xs = range(n)
            mx, my = (n - 1) / 2, sum(math.log(v) for v in d) / n
            g = sum((x - mx) * (math.log(v) - my) for x, v in zip(xs, d)) / sum((x - mx) ** 2 for x in xs)
            g = min(0.1, max(0.0, (g * n + 0.05 * 4) / (n + 4)))
        base = d[-1] if d else 6.0
        return base * math.exp(g * (k - len(d) + 1))


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
         "launch_q": 0.75, "n_share": 0.8, "spot_share": 0.3, "queue_months": 2, "spot_buf": 0.05}

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
        queue = [dict(q) for q in obs["queue"]]
        out = {}
        for k in range(t, T):
            out[k] = dict(owned)
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

    @staticmethod
    def reserved(obs, k):
        return sum(c["qty"] for c in obs["contracts"] if c["start"] <= k < c["end"])

    @staticmethod
    def compute(owned):
        return sum(owned[g] * W.COMPUTE[g] for g in owned)

    def __call__(self, obs, act):
        self.bel.update(obs)
        t, p = obs["month"], self.p
        cap = self.targets(obs)

        def add(key, item):
            nonlocal obs
            obs = obs | {key: obs[key] + [item]}

        # 1. hardware: order for month k only once waiting another month would make it late (pessimistic allocation)
        gen = "N" if obs["launched"] else "H"
        last = T - p["use_n" if gen == "N" else "use_h"]
        if t + W.MIN_LEAD <= last:
            proj = self.project(obs, pess=p["pess"])
            q = 0.0
            for k in range(t + W.MIN_LEAD, last + 1):
                g = (cap[k] - self.compute(proj[k]) - self.reserved(obs, k) - self.planned_n(obs, k)) / W.COMPUTE[gen]
                if g <= q + 0.25:
                    continue
                now = self.project(obs | {"queue": obs["queue"] + [{"gen": gen, "left": g, "placed": t}]}, pess=p["pess"])
                later = self.project(obs | {"queue": obs["queue"] + [{"gen": gen, "left": g, "placed": t + 1}]}, pess=p["pess"])
                arrive = now[k][gen] - proj[k][gen]              # what an order placed now delivers by month k
                if later[k][gen] - proj[k][gen] < arrive - 1e-6:  # waiting a month would deliver less in time
                    q = max(q, arrive)
            # tranches: a queue holding a few months of loose-regime allocation never wastes a shipment,
            # and later orders can use what the coming months reveal
            queued = sum(x["left"] for x in obs["queue"] if x["gen"] == gen)
            q = min(q, 30.0, p["queue_months"] * W.ALLOC[gen]["loose"] - queued)
            if q > 0.25:
                act(f"buy_gpus {q:.2f} {gen}")
                add("queue", {"gen": gen, "left": q, "placed": t, "ordered": q, "id": -1})
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
                terms = [m for m in (6, 12) if t + 1 + m <= T]
                long_ok = 12 in terms and not launch_soon and sum(resid.get(k, 0) > 0.3 for k in range(t + 1, t + 13)) >= 10
                cover = [m for m in terms if t + 1 + m > far]
                term = 12 if long_ok else (cover[0] if cover else (terms[-1] if terms else None))
                if term:
                    act(f"reserve {x:.2f} {term}")
                    add("contracts", {"qty": min(x, rc), "price": 0, "start": t + 1, "end": t + 1 + term})
        # 4. spot: whatever is still short this month
        gap_now = cap[t] - powered_compute(obs, t)[1] - self.reserved(obs, t)
        act(f"set_spot {max(0.0, gap_now + p['spot_buf'] * cap[t]):.2f}")   # extra spot is cheap next to a missed run
        if isinstance(self.bel, Bayes):
            elig = {g: sum(q["left"] for q in obs["queue"] if q["gen"] == g and t >= q["placed"] + W.MIN_LEAD - 1) for g in ("H", "N")}
            self.bel.pending = (t, elig, self.bel.export_start is not None and self.bel.export_factor(t, t) < 1.0)


class Clairvoyant(Reference):
    def __init__(self, w):
        super().__init__(Truth(w), m_inf=0.02, m_tr=0.05, pess=0.0, alloc_q=1.0, n_share=1.0)


class StopEarly(Reference):
    """The reference for the first 3 months, then nothing (played with stop_after=3)."""


class Exploiter(Reference):
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
          "exploiter": (Exploiter, None), "reference": (Reference, None), "clairvoyant": (Clairvoyant, None)}


def ladder(seed):
    return {name: play(pol, seed, stop) for name, (pol, stop) in LADDER.items()}
