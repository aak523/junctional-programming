"""Scripted policy ladder for GPU World.

Every policy except `oracle` sees only World.observe() and the documented rules (the constants in
world.py, which TASK.md states), and acts through the same text commands the agent uses.

- reference (`LPPolicy`): Bayesian filter over every hidden factor, then each month an LP over 24 futures
  sampled from the posterior (sample-average approximation, common random numbers across months); plays the
  first month's decisions.
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
REGIMES = ("loose", "tight")


def growth_rate(g, sw, k):
    """Monthly inference growth in month k under the hypothesis (g at month 0, switch at month sw or never)."""
    return g if sw is None or k < sw else W.GROWTH[1 - W.GROWTH.index(g)]


class Bayes:
    """Filters the supply regime, launch month, export controls, demand growth and broker reliability."""

    def __init__(self):
        self.b = 0.5                       # P(tight) for the current month
        self.launch = {m: 1.0 for m in range(W.LAUNCH_RANGE[0], W.LAUNCH_RANGE[1] + 1)}
        self.pending = None                # (eligible-by-gen, export_active) for shipment evidence
        self.asked = {s: 0.0 for s in SITES}   # reservation kH requested last month per site (cap-fill evidence)
        self.spike_last = False            # last month's news announced a rival spot buyer (spot caps halved)
        self.growth = {}                   # posterior over (growth at month 0, switch month or None)
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
        if hist:   # what last month's spot and reservation requests actually got: the caps depend on the regime
            exp_last = self.export_start is not None and self.export_start <= t - 1 < self.export_start + W.EXPORT_MONTHS
            for s in SITES:
                x = hist[-1]["sites"][s]
                if x["spot_requested"] > 0:
                    self._fill(x["spot_requested"], x["spot_filled"], {r: W.SPOT_CAP[r][s] * (0.5 if self.spike_last else 1.0)
                                                                       * (W.EXPORT_SPOT if exp_last else 1.0) for r in REGIMES})
                if self.asked[s] > 0:
                    got = sum(c["qty"] for c in obs["contracts"] if c["site"] == s and c["start"] == t and not c.get("option"))
                    self._fill(self.asked[s], got, {r: W.RESERVE_CAP[r][s] for r in REGIMES})
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
        self.spike_last = spike
        self._growth_update(hist)

    def _bayes(self, lt, ll):
        self.b = self.b * lt / (self.b * lt + (1 - self.b) * ll)

    def p_tight(self):
        return self.b

    def _fill(self, asked, got, cap):
        """Evidence from getting `got` of `asked` kH when the cap is `cap[regime]` (deterministic, up to rounding)."""
        like = {r: 1.0 if abs(got - min(asked, cap[r])) < 0.011 else 1e-3 for r in REGIMES}
        self._bayes(like["tight"], like["loose"])

    def note_actions(self, obs, asked):
        """Record what could have shipped this month and what was asked of each site's reservation cap, so next
        month's shipments and fills are evidence about this month's regime."""
        t = obs["month"]
        elig = {g: sum(q["left"] for q in obs["queue"] if q.get("src", "vendor") == "vendor" and q["gen"] == g
                       and t >= q["placed"] + W.MIN_LEAD - 1) for g in ("H", "N")}
        exp = self.export_start is not None and self.export_start <= t < self.export_start + W.EXPORT_MONTHS
        self.pending = (elig, exp)
        self.asked = dict(asked)

    def _growth_update(self, hist):
        """Exact posterior over (growth at month 0, switch month) under the documented demand model: log demand is
        the trend from DEMAND0 plus independent N(0, DEMAND_NOISE) noise each month."""
        d = [h["inference_demand"] for h in hist]
        lo, hi = W.GROWTH_SWITCH_RANGE
        ll = {}
        for g in W.GROWTH:
            for sw in (None, *range(lo, hi + 1)):
                prior = 0.5 * (W.GROWTH_SWITCH_P / (hi - lo + 1) if sw is not None else 1 - W.GROWTH_SWITCH_P)
                x, trend = math.log(prior), math.log(W.DEMAND0)
                for k, v in enumerate(d):
                    x -= 0.5 * ((math.log(v) - trend) / W.DEMAND_NOISE) ** 2
                    trend += growth_rate(g, sw, k)
                ll[g, sw] = x
        top = max(ll.values())
        z = sum(math.exp(x - top) for x in ll.values())
        self.growth = {h: math.exp(x - top) / z for h, x in ll.items()}

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
        g, sw = rng.choices(list(self.growth), list(self.growth.values()))[0]
        trend = math.log(W.DEMAND0) + sum(growth_rate(g, sw, k) for k in range(t))
        D = {}
        for k in range(t, T):
            D[k] = math.exp(trend + rng.gauss(0, W.DEMAND_NOISE))
            trend += growth_rate(g, sw, k)
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

    def p_tight(self):
        return 1.0 if self.w.regime[self.w.t] == "tight" else 0.0


# ---------------------------------------------------------------- the LP planner
class LPPolicy:
    """Model-predictive control: each month, solve the LP over future paths and play the first month's decisions.

    With posterior samples (`Bayes`) this is the reference; with the single true path it is the perfect-information
    policy. Broker reliability can only be learned by ordering, which the LP does not value, so both probe each
    broker once at the start. The spot request at each site is a high quantile of the per-path optimum (cheap
    insurance), and in a training window's last month at least the gap the LP's convex shortfall cost would leave
    (`guard`: the fixed penalty of a missed run is a cliff the LP cannot see). Charging unserved inference above its
    true cost was tried against the LP's inference-for-training leak and over-insured instead; `unserved` stays true."""
    P = {"paths": 24, "shortfall": 40.0, "spot_q": 0.75, "probe": 0.5, "margin": 0.03, "shared": 2,
         "unserved": W.UNSERVED_INFERENCE, "guard": True}

    def __init__(self, beliefs=None, seed=0, **params):
        self.bel = beliefs or Bayes()
        self.p = {**self.P, **params}
        self.seed = seed

    def paths(self, obs):
        if isinstance(self.bel, Truth):
            return [lp.oracle_path(self.bel.w)]
        # common random numbers: path i reuses its own stream every month, so the plan moves with the posterior, not with the sampling
        return [self.bel.sample_path(obs, random.Random(self.seed * 1009 + i)) for i in range(self.p["paths"])]

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
                return True
            except ValueError:
                return False
        gen = "N" if obs["launched"] else "H"
        if t == 0:   # exploration: a small order is the only way to learn a broker's reliability
            for b, mu in W.BROKERS.items():
                do(f"buy_gpus {p['probe']} {gen} {b} us")
                cost = p["probe"] * W.GPU_PRICE[gen] * mu
                obs = obs | {"cash": obs["cash"] - cost, "queue": obs["queue"] + [
                    {"gen": gen, "ordered": p["probe"], "left": p["probe"], "placed": t, "src": b, "paid": cost, "site": "us"}]}
        paths = self.paths(obs)
        dec, _, spot = lp.solve(lp.state_of(obs), paths, lead=self.lead(obs), shortfall=p["shortfall"],
                                margin=p["margin"], shared=p["shared"], unserved=p["unserved"])
        # the LP's convex shortfall cost cannot see the fixed penalty of a missed run: in a window's last month, if the
        # capacity already certain for this month leaves a gap under the highest-demand path, ask for it on spot (only
        # what is filled is paid for). Tight supply: ask every site, the caps are small. Loose: split it by the caps.
        def sure(k):   # training capacity in month k already certain: powered GPUs and active contracts, net of peak demand
            return sum(powered_compute(obs, s, k) - max(x["D"][s][k] for x in paths)
                       + sum(c["qty"] for c in obs["contracts"] if c["site"] == s and c["start"] <= k < c["end"]) for s in SITES)
        floor = {s: 0.0 for s in SITES}
        for (a, d, target), done in zip(MILESTONES, obs["window_training"]):
            if d == t and p["guard"]:
                need = target - done - sure(t) + 0.5
                if need > 0:
                    loose = W.SPOT_CAP["loose"]
                    floor = {s: need if self.bel.p_tight() > 0.5 else 1.3 * need * loose[s] / sum(loose.values()) for s in SITES}
        for s in SITES:   # spot first: it is this month's capacity
            level = max(floor[s], sorted(x[s] for x in spot)[min(len(spot) - 1, int(p["spot_q"] * len(spot)))])
            if abs(level - obs["spot_level"][s]) > 0.05:
                do(f"set_spot {max(0.0, level):.2f} {s}")
        for s in SITES:
            if dec["buy", s] > 0.25:
                do(f"buy_gpus {min(30.0, dec['buy', s]):.2f} {dec['gen']} {s}")
        for s in SITES:
            if dec["pw", s] > 0.5:
                do(f"contract_power {min(100.0, dec['pw', s]):.1f} {s}")
        asked = {s: 0.0 for s in SITES}
        held = obs["options"]
        if dec["opt"] > 0.25 and do(f"buy_option {dec['opt']:.2f}"):   # before exercising: the plan may exercise them now
            held += round(dec["opt"], 2)
        for s in SITES:
            for x in lp.TERMS:
                if dec["res", x, s] > 0.25 and do(f"reserve {dec['res', x, s]:.2f} {x} {s}"):
                    asked[s] += round(dec["res", x, s], 2)
            if dec["ex", s] > 0.25 and held > 0.05 and do(f"exercise_option {min(dec['ex', s], held):.2f} {s}"):
                held -= min(dec["ex", s], held)
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
            self.bel.note_actions(obs, asked)


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


class Committer(LPPolicy):
    """Stand-in for a frontier agent's early commitment (Gemini 4 Hydrogen's v5 games bought ~9k gen H GPUs in the
    first months and ~9k gen N at launch, at one cheap site): the reference planner, made to buy that fleet and its
    power regardless of the world, and planning everything else around it. Used offline (gap.py) to measure what the
    commitment costs against the reference without spending model credits."""
    P = {**LPPolicy.P, "fleet_h": 9.0, "fleet_n": 9.0, "buy_by": 2, "site": "ap"}

    def __init__(self, beliefs=None, seed=0, **params):
        super().__init__(beliefs, seed, **params)
        self.n_done = False

    def __call__(self, obs, act):
        super().__call__(obs, act)   # the planner sees this month's forced orders next month
        t, p, site = obs["month"], self.p, self.p["site"]

        def do(cmd):
            try:
                act(cmd)
                return True
            except ValueError:
                return False
        buy = {}
        if t <= p["buy_by"]:
            buy["H"] = p["fleet_h"] / (p["buy_by"] + 1)
        if obs["launched"] and not self.n_done:
            buy["N"], self.n_done = p["fleet_n"], True
        for g, q in buy.items():
            if q > 0 and do(f"buy_gpus {q:.2f} {g} {site}"):
                do(f"contract_power {q * W.POWER_MW[g]:.1f} {site}")


LADDER = {"do_nothing": (do_nothing, None), "stop_early": (StopEarly, 3), "spot_only": (SpotOnly, None),
          "exploiter": (Exploiter, None), "committer": (Committer, None), "reference": (LPPolicy, None), "oracle": (OracleMPC, None)}


def ladder(seed):
    out = {name: play(pol, seed, stop) for name, (pol, stop) in LADDER.items()}
    out["lp_bound"] = {"net_cost": round(lp.oracle(seed), 2), "milestones_met": None}
    return out
