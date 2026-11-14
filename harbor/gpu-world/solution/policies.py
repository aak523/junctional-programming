"""Scripted policy ladder for GPU World.

Every policy except `oracle` sees only World.observe() and the documented rules (the constants in
world.py, which TASK.md states), and acts through the same text commands the agent uses.

- reference (`LPPolicy`): Bayesian filter over every hidden factor, then each month an LP over 12 futures
  sampled from the posterior (sample-average approximation); plays the first month's decisions.
- oracle (`OracleMPC`): the same LP on the true future. Perfect information; an upper bound in practice.
"""
import math
import random

import lp
import world as W
from world import T, MILESTONES, SITES


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


def powered_compute(obs, s, k):
    owned = obs["owned"][s]
    mw = sum(p["mw"] for p in obs["power"] if p["site"] == s and p["start"] <= k < p["end"])
    n = min(owned["N"], mw / W.POWER_MW["N"])
    h = min(owned["H"], (mw - n * W.POWER_MW["N"]) / W.POWER_MW["H"])
    return h * W.COMPUTE["H"] + n * W.COMPUTE["N"]


class SpotOnly:
    """Myopic: never buys hardware; at each site rents this month's gap on spot, reserves 6 months when spot is dearer."""

    def __call__(self, obs, act):
        t = obs["month"]
        d = obs["history"][-1]["inference_demand"] * 1.05 if obs["history"] else 6.0
        need = next(((tg - done) / (e - t + 1) for (a, e, tg), done in zip(MILESTONES, obs["window_training"]) if a <= t <= e), 0)
        p = obs["prices"]
        for s in SITES:
            want = (d + max(0, need)) * W.INF_SHARE[s]
            res = sum(c["qty"] for c in obs["contracts"] if c["site"] == s and c["start"] <= t < c["end"])
            gap = want - powered_compute(obs, s, t) - res
            if gap > 0.5 and p["spot"] > p["reserve"][6] and t + 7 <= T:
                act(f"reserve {gap:.2f} 6 {s}")
            act(f"set_spot {max(0, gap):.2f} {s}")


# ---------------------------------------------------------------- beliefs
class Bayes:
    """Filters the supply regime, launch month, export controls, demand growth and broker reliability."""

    def __init__(self):
        self.b = 0.5                       # P(tight) for the current month
        self.launch = {m: 1.0 for m in range(W.LAUNCH_RANGE[0], W.LAUNCH_RANGE[1] + 1)}
        self.pending = None                # (eligible-by-gen, export_active) for shipment evidence
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
            elig, exp = self.pending
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
        lk = {r: math.exp(-0.5 * ((math.log(ratio) - math.log(W.SPOT_MULT[r])) / W.SPOT_NOISE) ** 2) for r in ("loose", "tight")}
        self._bayes(lk["tight"], lk["loose"])
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

    def note_queue(self, obs):
        """Record what could have shipped this month, so next month's shipments are evidence about the regime."""
        t = obs["month"]
        elig = {g: sum(q["left"] for q in obs["queue"] if q.get("src", "vendor") == "vendor" and q["gen"] == g
                       and t >= q["placed"] + W.MIN_LEAD - 1) for g in ("H", "N")}
        exp = self.export_start is not None and self.export_start <= t < self.export_start + W.EXPORT_MONTHS
        self.pending = (elig, exp)

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
        return {"L": L, "alloc": alloc, "cidx": c, "sprice": sprice, "bq": bq,
                "D": {s: {k: D[k] * W.INF_SHARE[s] for k in range(t, T)} for s in SITES},
                "scap": {s: {k: W.SPOT_CAP[reg[k]][s] * (0.5 if spike[k] else 1.0) * (W.EXPORT_SPOT if k in ex else 1.0)
                             for k in range(t, T)} for s in SITES},
                "rcap": {s: {k: W.RESERVE_CAP[reg[k]][s] for k in range(t, T)} for s in SITES}}


def decay_hazard(k):
    """P(a still-reliable broker turns unreliable at month k), from the documented prior."""
    lo, hi = W.BROKER_DECAY_RANGE
    if not lo <= k <= hi:
        return 0.0
    per = W.BROKER_DECAY_P / (hi - lo + 1)
    return per / (1 - per * (k - lo))


class Truth:
    """The hidden future, for the oracle."""

    def __init__(self, w):
        self.w = w

    def update(self, obs):
        pass


# ---------------------------------------------------------------- the LP planner
class LPPolicy:
    """Model-predictive control: each month, solve the LP over future paths and play the first month's decisions.

    With posterior samples (`Bayes`) this is the reference; with the single true path it is the perfect-information
    policy. Broker reliability can only be learned by ordering, which the LP does not value, so both probe each
    broker once at the start. The spot request at each site is a high quantile of the per-path optimum (cheap insurance)."""
    P = {"paths": 12, "shortfall": 40.0, "spot_q": 0.75, "probe": 0.5, "margin": 0.06, "shared": 2}

    def __init__(self, beliefs=None, seed=0, **params):
        self.bel = beliefs or Bayes()
        self.p = {**self.P, **params}
        self.rng = random.Random(seed)

    def paths(self, obs):
        if isinstance(self.bel, Truth):
            return [lp.oracle_path(self.bel.w)]
        return [self.bel.sample_path(obs, self.rng) for _ in range(self.p["paths"])]

    def lead(self, obs):
        if isinstance(self.bel, Truth):   # the oracle knows the next energisation date at each site
            w = self.bel.w
            return {s: w.power_leads[s][sum(1 for x in obs["power"] if x["site"] == s) % len(w.power_leads[s])] for s in SITES}
        return lp.LEAD

    def __call__(self, obs, act):
        self.bel.update(obs)
        t, p = obs["month"], self.p

        def do(cmd):
            try:
                act(cmd)
            except ValueError:
                pass
        gen = "N" if obs["launched"] else "H"
        if t == 0:   # exploration: a small order is the only way to learn a broker's reliability
            for b, mu in W.BROKERS.items():
                do(f"buy_gpus {p['probe']} {gen} {b} us")
                cost = p["probe"] * W.GPU_PRICE[gen] * mu
                obs = obs | {"cash": obs["cash"] - cost, "queue": obs["queue"] + [
                    {"gen": gen, "ordered": p["probe"], "left": p["probe"], "placed": t, "src": b, "paid": cost, "site": "us"}]}
        dec, _, spot = lp.solve(lp.state_of(obs), self.paths(obs), lead=self.lead(obs), shortfall=p["shortfall"],
                                margin=p["margin"], shared=p["shared"])
        for s in SITES:   # spot first: it is this month's capacity
            level = sorted(x[s] for x in spot)[min(len(spot) - 1, int(p["spot_q"] * len(spot)))]
            if abs(level - obs["spot_level"][s]) > 0.05:
                do(f"set_spot {max(0.0, level):.2f} {s}")
        for s in SITES:
            if dec["buy", s] > 0.25:
                do(f"buy_gpus {min(30.0, dec['buy', s]):.2f} {dec['gen']} {s}")
        for s in SITES:
            if dec["pw", s] > 0.5:
                do(f"contract_power {min(100.0, dec['pw', s]):.1f} {s}")
        for s in SITES:
            for x in lp.TERMS:
                if dec["res", x, s] > 0.25:
                    do(f"reserve {dec['res', x, s]:.2f} {x} {s}")
            if dec["ex", s] > 0.25:
                do(f"exercise_option {min(dec['ex', s], obs['options']):.2f} {s}")
        if dec["opt"] > 0.25:
            do(f"buy_option {dec['opt']:.2f}")
        for s in SITES:
            for b in W.BROKERS:
                if dec["b", b, s] > 0.25:
                    do(f"buy_gpus {dec['b', b, s]:.2f} {dec['gen']} {b} {s}")
        for g in lp.GENS:
            for a, b in lp.PAIRS:
                if dec["mv", g, a, b] > 0.25:
                    do(f"move_gpus {min(dec['mv', g, a, b], obs['owned'][a][g]):.2f} {g} {a} {b}")
            for s in SITES:
                if dec["r", g, s] > 0.25:
                    do(f"resell_gpus {min(dec['r', g, s], obs['owned'][s][g]):.2f} {g} {s}")
        if isinstance(self.bel, Bayes):
            self.bel.note_queue(obs)


class OracleMPC(LPPolicy):
    """LP-MPC on the true path: perfect information, but it plays in the real world (ops limit, integer effects)."""
    needs_world = True

    def __init__(self, w):
        super().__init__(Truth(w))


class StopEarly(LPPolicy):
    """The reference for the first 3 months, then nothing (played with stop_after=3)."""


class Exploiter(LPPolicy):
    """Reference play plus the obvious hacks: buy-and-flip GPUs, long contracts with obligations past the
    horizon, options bought and never used, and a pile of undelivered orders at the end."""

    def __call__(self, obs, act):
        super().__call__(obs, act)
        t = obs["month"]
        try:
            if t == 0:
                act("buy_gpus 10 H us")
                act("buy_option 20")
            for s in SITES:
                for g in ("H", "N"):
                    if obs["owned"][s][g] >= 3:
                        act(f"resell_gpus 3 {g} {s}")
            if t == T - 2:
                act("reserve 3 24 us")
            if t == T - 1:
                act("buy_gpus 30 us")
        except ValueError:
            pass


LADDER = {"do_nothing": (do_nothing, None), "stop_early": (StopEarly, 3), "spot_only": (SpotOnly, None),
          "exploiter": (Exploiter, None), "reference": (LPPolicy, None), "oracle": (OracleMPC, None)}


def ladder(seed):
    out = {name: play(pol, seed, stop) for name, (pol, stop) in LADDER.items()}
    out["lp_bound"] = {"net_cost": round(lp.oracle(seed), 2), "milestones_met": None}
    return out
