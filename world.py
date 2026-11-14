"""GPU World: compute procurement for an AI lab under hidden supply conditions.

Seeded, no LLM inside. All exogenous randomness (regime path, launch month,
export controls, demand, prices, headlines, power lead times) is drawn at
construction, so every policy faces the same world for a given seed.

Units: compute in kH (thousand H-class-GPU equivalents), money in $M, time in months 0..23.
"""
import ast
import math
import operator
import random

T = 24
OPS_PER_MONTH = 6
GPU_PRICE = {"H": 25.0, "N": 40.0}       # $M per thousand GPUs
COMPUTE = {"H": 1.0, "N": 2.0}            # kH per thousand GPUs
POWER_MW = {"H": 1.4, "N": 1.6}           # MW per thousand GPUs
POWER_COST = 0.15                         # $M per MW-month
POWER_TERM = 24
POWER_LEAD = (3, 8)
MIN_LEAD = 3                              # an order placed in month p is usable from month p+3 at the earliest
ALLOC = {"H": {"loose": 6.0, "tight": 2.0}, "N": {"loose": 4.0, "tight": 1.5}}  # thousand GPUs shipped/month, x U(0.7,1.3)
RESERVE_CAP = {"loose": 10.0, "tight": 3.0}  # kH of new reservations clouds accept per month
SPOT_CAP = {"loose": 12.0, "tight": 3.0}     # kH of spot capacity you can get per month
SPOT_MULT = {"loose": 1.1, "tight": 1.8}     # spot price / contract index (x lognormal noise)
SPOT_NOISE = 0.3
DRIFT = {"loose": 0.975, "tight": 1.04}       # monthly contract-index drift
DRIFT_NOISE = 0.05
TERM_FACTOR = {6: 1.15, 12: 1.0, 24: 0.9}
RESALE = 0.75                             # resale (and settlement mark) = 75% of market value
RESELL_CAP = 3.0                          # thousand GPUs resellable per month per generation
UNSERVED_INFERENCE = 4.0                  # $M lost per kH-month of unserved inference demand
MILESTONES = [(0, 7, 60.0), (8, 15, 140.0), (16, 23, 320.0)]  # (first month, last month, training kH-months needed within)
MISS_PENALTY, SHORTFALL_COST = 200.0, 5.0
SWITCH = 0.10
HEADLINE_RATE, HEADLINE_ACC = 0.7, 0.75
EXPORT_ALLOC, EXPORT_SPOT, EXPORT_MONTHS = 0.4, 0.6, 6
LAUNCH_RANGE = (11, 18)
LAUNCH_MV, LAUNCH_PRICE = 0.6, 0.75
SPIKE_P = 0.12
BROKERS = {"A": 1.10, "B": 1.25}          # price markup over list; usable 2 months after ordering, outside the vendor allocation
BROKER_CAP = 4.0                          # thousand GPUs per broker per month
BROKER_Q = {"reliable": 0.9, "unreliable": 0.35}  # chance an order is delivered; otherwise cancelled with a partial refund
BROKER_REFUND = 0.8
BROKER_DECAY_P, BROKER_DECAY_RANGE = 0.4, (8, 15)  # a reliable broker silently turns unreliable (once, at a hidden month)
GROWTH = (0.03, 0.07)                     # inference growth per month
GROWTH_SWITCH_P, GROWTH_SWITCH_RANGE = 0.5, (8, 15)  # growth silently switches to the other value (once)
CASH0, FUNDING, CREDIT, RATE = 400.0, 40.0, 500.0, 0.02  # $M cash, monthly funding, credit line, monthly interest on debt

BEARISH = ["CoWoS packaging lines reported fully booked through next year.",
           "HBM yields disappoint; memory makers cut shipment guidance.",
           "Distributors quote longer accelerator lead times to new customers.",
           "Hyperscalers said to be absorbing most of this quarter's accelerator output."]
BULLISH = ["New CoWoS capacity comes online ahead of schedule.",
           "HBM supply loosens as a third memory vendor qualifies.",
           "Distributors report accelerator inventory building up.",
           "Cloud providers cut list prices for reserved GPU capacity."]


class World:
    def __init__(self, seed):
        self.seed = seed
        rng = random.Random(seed)
        r = ["tight" if rng.random() < 0.5 else "loose"]
        for _ in range(T - 1):
            r.append(({"tight": "loose", "loose": "tight"}[r[-1]]) if rng.random() < SWITCH else r[-1])
        self.regime = r
        self.launch = rng.randint(*LAUNCH_RANGE)
        self.export = rng.randint(5, 15) if rng.random() < 0.5 else None
        g = rng.choice(GROWTH)
        noise = [rng.gauss(0, 0.05) for _ in range(T)]
        c = [1.6]
        for k in range(1, T + 1):
            x = c[-1] * DRIFT[r[k - 1]] * math.exp(rng.gauss(0, DRIFT_NOISE))
            if k == self.launch:
                x *= LAUNCH_PRICE
            c.append(min(4.0, max(0.8, x)))
        self.cindex = c
        self.spike = [rng.random() < SPIKE_P for _ in range(T)]
        self.spot_noise = [math.exp(rng.gauss(0, SPOT_NOISE)) for _ in range(T)]
        self.alloc_noise = [{g_: rng.uniform(0.7, 1.3) for g_ in ("H", "N")} for _ in range(T)]
        self.power_leads = [rng.randint(*POWER_LEAD) for _ in range(200)]
        self.news = [self._headlines(rng, k) for k in range(T)]
        # v3 hidden state (drawn after the v2 draws): silent growth switch, broker reliability
        self.growth_switch = rng.randint(*GROWTH_SWITCH_RANGE) if rng.random() < GROWTH_SWITCH_P else None
        g2 = GROWTH[1] if g == GROWTH[0] else GROWTH[0]
        self.growth = [g if self.growth_switch is None or k < self.growth_switch else g2 for k in range(T)]
        self.demand = [round(6.0 * math.exp(sum(self.growth[:k]) + noise[k]), 2) for k in range(T)]
        self.broker_reliable, self.broker_decay, self.broker_u = {}, {}, {}
        for b in BROKERS:
            self.broker_reliable[b] = rng.random() < 0.5
            self.broker_decay[b] = rng.randint(*BROKER_DECAY_RANGE) if self.broker_reliable[b] and rng.random() < BROKER_DECAY_P else None
            self.broker_u[b] = [rng.random() for _ in range(200)]

        self.t, self.ops = 0, 0
        self.owned = {"H": 10.0, "N": 0.0}
        self.queue = [{"id": 1, "gen": "H", "qty": 4.0, "left": 4.0, "placed": -2, "src": "vendor", "paid": 100.0}]
        self.power = [{"mw": 16.0, "start": -4, "end": -4 + POWER_TERM}]
        self.contracts = [{"qty": 2.0, "price": 2.0, "start": -7, "end": 5}]
        self.spot_level = 0.0
        self.resold = {"H": 0.0, "N": 0.0}
        self.reserved_now = 0.0
        self.cost = {"capex": 0.0, "power": 0.0, "contracts": 0.0, "spot": 0.0, "unserved": 0.0, "resale": 0.0, "interest": 0.0}
        self.cash = CASH0
        self.broker_bought = {b: 0.0 for b in BROKERS}
        self.broker_orders = {b: 0 for b in BROKERS}
        self.met = {}
        self.history = []      # one report per finished month
        self.next_id = 2
        self.settlement = None

    # ------------------------------------------------------------ exogenous
    def _headlines(self, rng, k):
        out = []
        if rng.random() < HEADLINE_RATE:
            right = rng.random() < HEADLINE_ACC
            bear = (self.regime[k] == "tight") == right
            out.append(rng.choice(BEARISH if bear else BULLISH))
        if self.spike[k]:
            out.append(f"Rival lab closes a ${rng.randint(4, 15)}B round and is buying spot GPU capacity aggressively this month.")
        if self.export is not None and k in (self.export - 2, self.export - 1):
            if rng.random() < 0.6:
                out.append("Sources: new accelerator export-control rules are being drafted and could take effect within weeks.")
        elif rng.random() < 0.06:
            out.append("Sources: new accelerator export-control rules are being drafted and could take effect within weeks.")
        if self.export is not None and k == self.export:
            out.append(f"Export controls take effect this month: accelerator shipments sharply curtailed for about {EXPORT_MONTHS} months.")
        if k < self.launch:
            if rng.random() < 0.35:
                out.append(f"Supply-chain sources: next-gen accelerator (gen N) expected to launch around month {self.launch + rng.randint(-2, 2)}.")
            if k == self.launch - 1 and rng.random() < 0.8:
                out.append("Vendor confirms the gen N launch event for next month.")
        elif k == self.launch:
            out.append("Gen N launched: orders open now. Gen H is discontinued; used H prices fall.")
        return out

    def export_active(self, k):
        return self.export is not None and self.export <= k < self.export + EXPORT_MONTHS

    def launched(self, k=None):
        return (self.t if k is None else k) >= self.launch

    def market_value(self, gen, k=None):
        k = self.t if k is None else k
        if gen == "H":
            return GPU_PRICE["H"] * 0.98 ** k * (LAUNCH_MV if k >= self.launch else 1.0)
        return GPU_PRICE["N"] * 0.98 ** max(0, k - self.launch) if k >= self.launch else 0.0

    def spot_price(self, k=None):
        k = self.t if k is None else k
        return self.cindex[k] * SPOT_MULT[self.regime[k]] * self.spot_noise[k] * (1.5 if self.spike[k] else 1.0)

    def broker_q(self, b, k):
        if not self.broker_reliable[b] or (self.broker_decay[b] is not None and k >= self.broker_decay[b]):
            return BROKER_Q["unreliable"]
        return BROKER_Q["reliable"]

    def term_price(self, months, k=None):
        return self.cindex[self.t if k is None else k] * TERM_FACTOR[months]

    # ------------------------------------------------------------ actions
    def _op(self):
        if self.t >= T:
            raise ValueError("the episode is over")
        if self.ops >= OPS_PER_MONTH:
            raise ValueError(f"no operations left this month ({OPS_PER_MONTH} used); call end_month")
        self.ops += 1

    def buy_gpus(self, qty, gen=None, src="vendor"):
        gen = gen or ("N" if self.launched() else "H")
        if gen == "N" and not self.launched():
            raise ValueError("gen N is not on sale yet")
        if gen == "H" and self.launched():
            raise ValueError("gen H is discontinued since the gen N launch")
        if src != "vendor" and src not in BROKERS:
            raise ValueError("source must be vendor, A or B")
        if not 0 < qty <= 30:
            raise ValueError("qty must be in (0, 30] thousand GPUs per order")
        if src in BROKERS and self.broker_bought[src] + qty > BROKER_CAP + 1e-9:
            raise ValueError(f"broker {src} sells at most {BROKER_CAP:g}k per month ({self.broker_bought[src]:g}k bought this month)")
        price = qty * GPU_PRICE[gen] * (BROKERS[src] if src in BROKERS else 1.0)
        if self.cash - price < -CREDIT - 1e-9:
            raise ValueError(f"not enough cash or credit: ${price:.1f}M needed, cash ${self.cash:.1f}M, credit line ${CREDIT:g}M")
        self._op()
        self.cash -= price
        self.cost["capex"] += price
        order = {"id": self.next_id, "gen": gen, "qty": qty, "left": qty, "placed": self.t, "src": src, "paid": price}
        self.next_id += 1
        self.queue.append(order)
        if src in BROKERS:
            self.broker_bought[src] += qty
            order["n"] = self.broker_orders[src]
            self.broker_orders[src] += 1
            return (f"Ordered {qty:g}k gen {gen} GPUs from broker {src} for ${price:.1f}M (paid now). Order #{order['id']}: the broker "
                    f"confirms delivery or cancellation at the end of month {self.t + 1}; if delivered, usable from month {self.t + 2}.")
        return (f"Ordered {qty:g}k gen {gen} GPUs for ${price:.1f}M (paid now). Order #{order['id']} joins the vendor {gen} queue; "
                f"usable from month {self.t + MIN_LEAD} at the earliest.")

    def reserve(self, qty, months):
        if months not in TERM_FACTOR:
            raise ValueError("months must be 6, 12 or 24")
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._op()
        cap = RESERVE_CAP[self.regime[self.t]] - self.reserved_now
        got = round(max(0.0, min(qty, cap)), 2)
        if got <= 0:
            return "No reserved capacity available from cloud providers this month. (The operation is still used.)"
        price = self.term_price(months)
        self.reserved_now += got
        self.contracts.append({"qty": got, "price": price, "start": self.t + 1, "end": self.t + 1 + months})
        note = "" if got == qty else f" Providers could only fill {got:g} of the {qty:g} kH you asked for this month."
        return (f"Reserved {got:g} kH for {months} months at ${price:.3f}M per kH-month, months {self.t + 1}..{self.t + months}. "
                f"Committed: you pay for the full term even after month {T - 1}.{note}")

    def set_spot(self, qty):
        if qty < 0:
            raise ValueError("qty must be >= 0")
        self._op()
        self.spot_level = qty
        return f"Standing spot request set to {qty:g} kH per month (filled at month end, as far as spot supply allows, at that month's spot price)."

    def contract_power(self, mw):
        if not 0 < mw <= 100:
            raise ValueError("mw must be in (0, 100]")
        self._op()
        lead = self.power_leads[len(self.power) % len(self.power_leads)]
        self.power.append({"mw": mw, "start": self.t + lead, "end": self.t + lead + POWER_TERM})
        return (f"Signed {mw:g} MW of colocation power. Utility energisation date: month {self.t + lead}. "
                f"You pay ${POWER_COST}M/MW-month from then for {POWER_TERM} months (obligation past month {T - 1} is charged at settlement).")

    def resell_gpus(self, qty, gen="H"):
        if gen not in self.owned:
            raise ValueError("gen must be H or N")
        if not 0 < qty <= self.owned[gen] + 1e-9:
            raise ValueError(f"you own {self.owned[gen]:g}k gen {gen} delivered GPUs")
        if self.resold[gen] + qty > RESELL_CAP + 1e-9:
            raise ValueError(f"the used market absorbs at most {RESELL_CAP:g}k per generation per month ({self.resold[gen]:g}k sold so far)")
        self._op()
        income = qty * RESALE * self.market_value(gen)
        self.cash += income
        self.owned[gen] -= qty
        self.resold[gen] += qty
        self.cost["resale"] -= income
        return f"Sold {qty:g}k gen {gen} GPUs for ${income:.1f}M."

    # ------------------------------------------------------------ month end
    def powered(self, k, owned=None):
        owned = owned or self.owned
        mw = sum(p["mw"] for p in self.power if p["start"] <= k < p["end"])
        n = min(owned["N"], mw / POWER_MW["N"])
        h = min(owned["H"], (mw - n * POWER_MW["N"]) / POWER_MW["H"])
        return mw, {"H": h, "N": n}

    def end_month(self):
        if self.t >= T:
            raise ValueError("the episode is over")
        k = self.t
        mw, pw = self.powered(k)
        own_c = sum(pw[g] * COMPUTE[g] for g in pw)
        reserved = sum(c["qty"] for c in self.contracts if c["start"] <= k < c["end"])
        cap = SPOT_CAP[self.regime[k]] * (0.5 if self.spike[k] else 1.0) * (EXPORT_SPOT if self.export_active(k) else 1.0)
        spot = min(self.spot_level, cap)
        sp = self.spot_price(k)
        capacity = own_c + reserved + spot
        served = min(self.demand[k], capacity)
        training = capacity - served
        charges = {"power": mw * POWER_COST, "spot": spot * sp,
                   "contracts": sum(c["qty"] * c["price"] for c in self.contracts if c["start"] <= k < c["end"])}
        for key, v in charges.items():
            self.cost[key] += v
            self.cash -= v
        self.cost["unserved"] += (self.demand[k] - served) * UNSERVED_INFERENCE
        for a, d, target in MILESTONES:
            if d == k:
                self.met[d] = self.window_training(a, d) + training >= target - 1e-9
        shipped = {}
        for gen in ("H", "N"):
            a = ALLOC[gen][self.regime[k]] * self.alloc_noise[k][gen] * (EXPORT_ALLOC if gen == "H" and self.export_active(k) else 1.0)
            shipped[gen] = 0.0
            for o in self.queue:
                if o["src"] == "vendor" and o["gen"] == gen and o["left"] > 0 and k >= o["placed"] + MIN_LEAD - 1 and a > 0:
                    s = min(o["left"], a)
                    o["left"] -= s
                    a -= s
                    shipped[gen] += s
                    self.owned[gen] += s
        broker = []
        for o in self.queue:
            if o["src"] in BROKERS and o["placed"] + 1 == k:
                ok = self.broker_u[o["src"]][o["n"]] < self.broker_q(o["src"], k)
                if ok:
                    self.owned[o["gen"]] += o["qty"]
                else:
                    refund = BROKER_REFUND * o["paid"]
                    self.cash += refund
                    self.cost["capex"] -= refund
                o["left"] = 0.0
                broker.append({"id": o["id"], "src": o["src"], "gen": o["gen"], "qty": o["qty"], "placed": o["placed"], "delivered": ok})
        self.queue = [o for o in self.queue if o["left"] > 1e-9]
        interest = RATE * -self.cash if self.cash < 0 else 0.0
        self.cost["interest"] += interest
        self.cash -= interest
        self.history.append({"month": k, "inference_demand": self.demand[k], "served": round(served, 2),
                             "own_compute": round(own_c, 2), "powered": {g: round(v, 2) for g, v in pw.items()},
                             "reserved": reserved, "spot_requested": self.spot_level, "spot_filled": round(spot, 2),
                             "spot_price": round(sp, 3), "capacity": round(capacity, 2), "training": round(training, 2),
                             "shipped": {g: round(v, 2) for g, v in shipped.items()}, "broker": broker,
                             "interest": round(interest, 2), "cash_end": round(self.cash, 2)})
        self.cash += FUNDING
        self.broker_bought = {b: 0.0 for b in BROKERS}
        self.t += 1
        self.ops = 0
        self.resold = {"H": 0.0, "N": 0.0}
        self.reserved_now = 0.0
        if self.t == T:
            self.settle()

    def settle(self):
        for o in self.queue:   # broker orders still unconfirmed at the end are cancelled with the usual refund
            if o["src"] in BROKERS:
                self.cost["capex"] -= BROKER_REFUND * o["paid"]
        mark = sum(RESALE * self.market_value(g, T) * (self.owned[g] + sum(o["left"] for o in self.queue if o["gen"] == g and o["src"] == "vendor"))
                   for g in ("H", "N"))
        obligations = sum(c["qty"] * c["price"] * (c["end"] - max(c["start"], T)) for c in self.contracts if c["end"] > T)
        obligations += sum(p["mw"] * POWER_COST * (p["end"] - max(p["start"], T)) for p in self.power if p["end"] > T)
        missed = [d for _, d, _ in MILESTONES if not self.met.get(d)]
        shortfall = sum(max(0.0, target - self.window_training(a, d)) for a, d, target in MILESTONES)
        penalties = MISS_PENALTY * len(missed) + SHORTFALL_COST * shortfall
        spend = sum(self.cost.values())
        self.settlement = {"spend": round(spend, 2), "mark_to_market": round(mark, 2), "obligations": round(obligations, 2),
                           "milestones_met": len(MILESTONES) - len(missed), "missed": missed, "penalties": round(penalties, 2),
                           "net_cost": round(spend - mark + obligations + penalties, 2), "costs": {k: round(v, 2) for k, v in self.cost.items()}}

    def window_training(self, a, d):
        return sum(h["training"] for h in self.history if a <= h["month"] <= d)

    def finish(self):
        """Run the remaining months with no further actions (what happens if the agent stops)."""
        while self.t < T:
            self.end_month()
        return self.settlement

    # ------------------------------------------------------------ observation
    def observe(self):
        """Everything a player can see. Policies only get this."""
        k = self.t
        return {
            "month": k, "ops_left": OPS_PER_MONTH - self.ops, "launched": self.launched() if k < T else True,
            "owned": dict(self.owned),
            "power_active_mw": sum(p["mw"] for p in self.power if p["start"] <= k < p["end"]),
            "power": [dict(p) for p in self.power],
            "queue": [{"id": o["id"], "gen": o["gen"], "ordered": o["qty"], "left": round(o["left"], 2), "placed": o["placed"], "src": o["src"]}
                      for o in self.queue],
            "cash": round(self.cash, 2),
            "contracts": [dict(c) for c in self.contracts if c["end"] > k],
            "spot_level": self.spot_level,
            "prices": None if k >= T else {
                "gpu": {g: GPU_PRICE[g] for g in (("N",) if self.launched() else ("H",))},
                "spot": round(self.spot_price(), 3), "reserve": {m: round(self.term_price(m), 3) for m in TERM_FACTOR},
                "market_value": {g: round(self.market_value(g), 2) for g in ("H", "N") if g == "H" or self.launched()},
                "broker": {b: round(GPU_PRICE["N" if self.launched() else "H"] * m, 2) for b, m in BROKERS.items()}},
            "window_training": [round(self.window_training(a, d), 2) for a, d, _ in MILESTONES], "milestones": MILESTONES, "met": dict(self.met),
            "history": list(self.history), "news": self.news[k] if k < T else [],
            "spent": {k_: round(v, 2) for k_, v in self.cost.items()},
        }

    def render(self):
        o = self.observe()
        if self.t >= T:
            s = self.settlement
            return ("EPISODE OVER. Settlement:\n" + "\n".join(f"  {k}: {v}" for k, v in s.items()))
        L = [f"=== Month {o['month']} of 0..{T - 1} === operations left this month: {o['ops_left']}"]
        if o["history"]:
            h = o["history"][-1]
            L.append(f"Last month (month {h['month']}): inference demand {h['inference_demand']} kH, served {h['served']}; "
                     f"capacity {h['capacity']} kH = owned&powered {h['own_compute']} + reserved {h['reserved']:g} + spot {h['spot_filled']:g} "
                     f"(requested {h['spot_requested']:g}, price ${h['spot_price']}M/kH-month); training {h['training']} kH-months. "
                     f"Vendor shipments received: H {h['shipped']['H']:g}k, N {h['shipped']['N']:g}k." +
                     "".join(f" Broker {e['src']} order #{e['id']} ({e['qty']:g}k gen {e['gen']}): " +
                             ("DELIVERED." if e["delivered"] else f"CANCELLED, {BROKER_REFUND:.0%} refunded.") for e in h["broker"]) +
                     (f" Interest charged: ${h['interest']:g}M." if h["interest"] else ""))
        L.append("Training runs (kH-months done / needed within months a..b): " + "; ".join(
            f"months {a}..{d}: {done:g} / {t:g}" + (" MET" if o["met"].get(d) else " MISSED" if d in o["met"] else "")
            for (a, d, t), done in zip(MILESTONES, o["window_training"])))
        _, pw = self.powered(self.t)
        L.append(f"Owned delivered GPUs: H {o['owned']['H']:.2f}k, N {o['owned']['N']:.2f}k; powered this month: H {pw['H']:.2f}k, N {pw['N']:.2f}k.")
        L.append(f"Power: {o['power_active_mw']:g} MW active this month. Contracts: " +
                 "; ".join(f"{p['mw']:g} MW months {p['start']}..{p['end'] - 1}" for p in o["power"] if p["end"] > self.t))
        L.append(f"Cash: ${o['cash']:.1f}M (credit line ${CREDIT:g}M; {RATE:.0%}/month interest on debt; +${FUNDING:g}M funding each month).")
        L.append("Vendor queue (FIFO per generation): " + ("; ".join(
            f"#{q['id']} gen {q['gen']} {q['left']:g}k of {q['ordered']:g}k still to ship (placed month {q['placed']})"
            for q in o["queue"] if q["src"] == "vendor") or "empty") + ". Broker orders awaiting confirmation: " + ("; ".join(
            f"#{q['id']} broker {q['src']} {q['ordered']:g}k gen {q['gen']} (placed month {q['placed']})"
            for q in o["queue"] if q["src"] != "vendor") or "none"))
        L.append("Reserved cloud contracts: " + ("; ".join(
            f"{c['qty']:g} kH at ${c['price']:.3f}M months {c['start']}..{c['end'] - 1}" for c in o["contracts"]) or "none"))
        p = o["prices"]
        L.append(f"Prices now: buy {', '.join(f'gen {g} ${v:g}M per 1k GPUs' for g, v in p['gpu'].items())} from the vendor, "
                 f"{', '.join(f'${v:g}M from broker {b}' for b, v in p['broker'].items())}; "
                 f"reserve per kH-month: 6m ${p['reserve'][6]}, 12m ${p['reserve'][12]}, 24m ${p['reserve'][24]}; "
                 f"spot this month ${p['spot']}M per kH-month (standing request {o['spot_level']:g} kH); "
                 f"used-market value per 1k GPUs: " + ", ".join(f"{g} ${v:g}M" for g, v in p["market_value"].items()) + ".")
        L.append("News: " + (" | ".join(o["news"]) or "(nothing notable)"))
        L.append("Spent so far ($M): " + ", ".join(f"{k}: {v:g}" for k, v in o["spent"].items()))
        return "\n".join(L)

    # ------------------------------------------------------------ text commands
    def command(self, line):
        parts = line.split()
        if not parts:
            raise ValueError("empty command")
        name, args = parts[0], parts[1:]
        if name == "end_month":
            self.end_month()
            return self.render()
        def num(i):
            x = float(args[i])
            if not math.isfinite(x):
                raise ValueError("quantities must be finite numbers")
            return x
        table = {
            "buy_gpus": lambda: self.buy_gpus(num(0), *buy_args(args[1:])),
            "reserve": lambda: self.reserve(num(0), int(args[1])),
            "set_spot": lambda: self.set_spot(num(0)),
            "contract_power": lambda: self.contract_power(num(0)),
            "resell_gpus": lambda: self.resell_gpus(num(0), args[1].upper() if len(args) > 1 else "H"),
        }
        if name not in table:
            raise ValueError(f"unknown command {name!r}")
        try:
            return table[name]()
        except (IndexError, ValueError) as e:
            if isinstance(e, IndexError):
                raise ValueError(f"missing argument for {name}")
            raise


def buy_args(rest):
    gen, src = None, "vendor"
    for a in rest:
        if a.upper() in ("H", "N"):
            gen = a.upper()
        elif a.upper() in BROKERS or a.lower() == "vendor":
            src = a.upper() if a.upper() in BROKERS else "vendor"
        else:
            raise ValueError(f"unknown buy_gpus argument {a!r}: use H|N and vendor|A|B")
    return gen, src


ACTIONS = ("buy_gpus", "reserve", "set_spot", "contract_power", "resell_gpus", "end_month")

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos}


def calc(expr):
    """Arithmetic only: numbers, + - * / ** and parentheses, min/max/round."""
    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            a, b = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Pow) and (abs(b) > 100 or abs(a) > 1e6):
                raise ValueError("exponent too large")
            return _OPS[type(n.op)](a, b)
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ("min", "max", "round") and not n.keywords:
            return {"min": min, "max": max, "round": round}[n.func.id](*[ev(a) for a in n.args])
        raise ValueError("calc supports numbers, + - * / **, parentheses, min, max, round")
    return ev(ast.parse(expr, mode="eval"))
