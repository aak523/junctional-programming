"""GPU World: compute procurement for an AI lab across three sites under hidden, drifting supply conditions.

Seeded, no LLM inside. All exogenous randomness (regime path, launch month, export controls,
demand, prices, headlines, power lead times, broker reliability) is drawn at construction, so
every policy faces the same world for a given seed.

Units: compute in kH (thousand H-class-GPU equivalents), money in $M, time in months 0..23.
"""
import ast
import math
import operator
import random

T = 24
OPS_PER_MONTH = 15
SITES = ("us", "eu", "ap")
GPU_PRICE = {"H": 25.0, "N": 40.0}       # $M per thousand GPUs
COMPUTE = {"H": 1.0, "N": 2.0}            # kH per thousand GPUs
POWER_MW = {"H": 1.4, "N": 1.6}           # MW per thousand GPUs
POWER_COST = {"us": 0.15, "eu": 0.20, "ap": 0.12}      # $M per MW-month
POWER_LEAD = {"us": (3, 8), "eu": (4, 9), "ap": (2, 6)}  # months from signing to energisation
POWER_TERM = 24
MIN_LEAD = 3                              # a vendor order placed in month p is usable from month p+3 at the earliest
ALLOC = {"H": {"loose": 6.0, "tight": 2.0}, "N": {"loose": 4.0, "tight": 1.5}}  # thousand GPUs shipped/month, x U(0.7,1.3)
RESERVE_CAP = {"loose": {"us": 4.0, "eu": 3.0, "ap": 3.0}, "tight": {"us": 1.0, "eu": 1.0, "ap": 1.0}}  # new kH/month
SPOT_CAP = {"loose": {"us": 5.0, "eu": 4.0, "ap": 3.0}, "tight": {"us": 1.5, "eu": 1.0, "ap": 0.5}}     # kH/month
SITE_PRICE = {"us": 1.0, "eu": 1.1, "ap": 0.95}      # multiplier on the contract index and spot price
INF_SHARE = {"us": 0.5, "eu": 0.3, "ap": 0.2}        # share of inference demand at each site (served locally)
SPOT_MULT = {"loose": 1.1, "tight": 1.8}     # spot price / contract index (x lognormal noise)
SPOT_NOISE = 0.3
DRIFT = {"loose": 0.975, "tight": 1.04}       # monthly contract-index drift
DRIFT_NOISE = 0.05
TERM_FACTOR = {6: 1.15, 12: 1.0, 24: 0.9}
MOVE_COST, MOVE_CAP = 0.5, 5.0            # $M per thousand GPUs moved; thousand GPUs per month; they arrive next month
OPTION_PREMIUM, OPTION_STRIKE, OPTION_TERM, OPTION_CAP = 1.0, 1.6, 6, 20.0  # $M/kH; $M/kH-month; months; kH bought/month
RESALE = 0.75                             # resale (and settlement mark) = 75% of market value
DEPR = 0.96                               # used-market value of a GPU generation falls 4% per month
RESELL_CAP = 3.0                          # thousand GPUs resellable per month per generation (all sites together)
UNSERVED_INFERENCE = 4.0                  # $M lost per kH-month of unserved inference demand
MILESTONES = [(0, 7, 60.0), (8, 15, 140.0), (16, 23, 320.0)]  # (first month, last month, training kH-months needed within)
MISS_PENALTY, SHORTFALL_COST = 200.0, 5.0
SWITCH = 0.10
HEADLINE_RATE, HEADLINE_ACC = 0.7, 0.75
EXPORT_ALLOC, EXPORT_SPOT, EXPORT_MONTHS = 0.4, 0.6, 6
LAUNCH_RANGE = (9, 15)
LAUNCH_MV, LAUNCH_PRICE = 0.5, 0.75
SPIKE_P = 0.12
BROKERS = {"A": 1.10, "B": 1.25}          # price markup over list; usable 2 months after ordering, outside the vendor allocation
BROKER_CAP = 4.0                          # thousand GPUs per broker per month
BROKER_Q = {"reliable": 0.9, "unreliable": 0.35}  # chance an order is delivered; otherwise cancelled with a partial refund
BROKER_REFUND = 0.8
BROKER_DECAY_P, BROKER_DECAY_RANGE = 0.4, (8, 15)  # a reliable broker silently turns unreliable (once, at a hidden month)
GROWTH = (0.04, 0.08)                     # inference growth per month
GROWTH_SWITCH_P, GROWTH_SWITCH_RANGE = 0.5, (8, 15)  # growth silently switches to the other value (once)
DEMAND0, DEMAND_NOISE = 6.0, 0.05         # kH at month 0; lognormal noise around the demand trend each month
CASH0, FUNDING, CREDIT, RATE = 400.0, 40.0, 500.0, 0.02  # $M cash, monthly funding, credit line, monthly interest on debt
EARN = 0.0075                             # monthly interest earned on a positive month-end balance (the lab's cost of capital)

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
        noise = [rng.gauss(0, DEMAND_NOISE) for _ in range(T)]
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
        self.power_leads = {s: [rng.randint(*POWER_LEAD[s]) for _ in range(100)] for s in SITES}
        self.news = [self._headlines(rng, k) for k in range(T)]
        self.growth_switch = rng.randint(*GROWTH_SWITCH_RANGE) if rng.random() < GROWTH_SWITCH_P else None
        g2 = GROWTH[1] if g == GROWTH[0] else GROWTH[0]
        self.growth = [g if self.growth_switch is None or k < self.growth_switch else g2 for k in range(T)]
        self.demand = [round(DEMAND0 * math.exp(sum(self.growth[:k]) + noise[k]), 2) for k in range(T)]
        self.broker_reliable, self.broker_decay, self.broker_u = {}, {}, {}
        for b in BROKERS:
            self.broker_reliable[b] = rng.random() < 0.5
            self.broker_decay[b] = rng.randint(*BROKER_DECAY_RANGE) if self.broker_reliable[b] and rng.random() < BROKER_DECAY_P else None
            self.broker_u[b] = [rng.random() for _ in range(200)]

        self.t, self.ops = 0, 0
        self.owned = {"us": {"H": 6.0, "N": 0.0}, "eu": {"H": 4.0, "N": 0.0}, "ap": {"H": 0.0, "N": 0.0}}
        self.queue = [{"id": 1, "gen": "H", "qty": 4.0, "left": 4.0, "placed": -2, "src": "vendor", "paid": 100.0, "site": "us"}]
        self.power = [{"mw": 10.0, "start": -4, "end": -4 + POWER_TERM, "site": "us"},
                      {"mw": 6.0, "start": -4, "end": -4 + POWER_TERM, "site": "eu"}]
        self.contracts = [{"qty": 2.0, "price": 2.0, "start": -7, "end": 5, "site": "us"}]
        self.spot_level = {s: 0.0 for s in SITES}
        self.options = 0.0
        self.moves = []          # GPUs in transit between sites: {gen, qty, to, arrive}
        self.resold = {"H": 0.0, "N": 0.0}
        self.reserved_now = {s: 0.0 for s in SITES}
        self.moved_now = 0.0
        self.options_now = 0.0
        self.cost = {"capex": 0.0, "power": 0.0, "contracts": 0.0, "spot": 0.0, "unserved": 0.0, "resale": 0.0,
                     "interest": 0.0, "moves": 0.0, "options": 0.0}
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
            return GPU_PRICE["H"] * DEPR ** k * (LAUNCH_MV if k >= self.launch else 1.0)
        return GPU_PRICE["N"] * DEPR ** max(0, k - self.launch) if k >= self.launch else 0.0

    def spot_price(self, k=None):
        """Base spot price; a site pays this times SITE_PRICE."""
        k = self.t if k is None else k
        return self.cindex[k] * SPOT_MULT[self.regime[k]] * self.spot_noise[k] * (1.5 if self.spike[k] else 1.0)

    def spot_cap(self, s, k):
        return SPOT_CAP[self.regime[k]][s] * (0.5 if self.spike[k] else 1.0) * (EXPORT_SPOT if self.export_active(k) else 1.0)

    def site_demand(self, s, k):
        return self.demand[k] * INF_SHARE[s]

    def broker_q(self, b, k):
        if not self.broker_reliable[b] or (self.broker_decay[b] is not None and k >= self.broker_decay[b]):
            return BROKER_Q["unreliable"]
        return BROKER_Q["reliable"]

    def term_price(self, months, site="us", k=None):
        return self.cindex[self.t if k is None else k] * TERM_FACTOR[months] * SITE_PRICE[site]

    # ------------------------------------------------------------ actions
    def _op(self):
        if self.t >= T:
            raise ValueError("the episode is over")
        if self.ops >= OPS_PER_MONTH:
            raise ValueError(f"no operations left this month ({OPS_PER_MONTH} used); call end_month")
        self.ops += 1

    @staticmethod
    def _site(site):
        if site not in SITES:
            raise ValueError(f"name a site: {', '.join(SITES)}")
        return site

    def _pay(self, amount):
        if self.cash - amount < -CREDIT - 1e-9:
            raise ValueError(f"not enough cash or credit: ${amount:.1f}M needed, cash ${self.cash:.1f}M, credit line ${CREDIT:g}M")

    def buy_gpus(self, qty, gen=None, src="vendor", site=None):
        site = self._site(site)
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
        self._pay(price)
        self._op()
        self.cash -= price
        self.cost["capex"] += price
        order = {"id": self.next_id, "gen": gen, "qty": qty, "left": qty, "placed": self.t, "src": src, "paid": price, "site": site}
        self.next_id += 1
        self.queue.append(order)
        if src in BROKERS:
            self.broker_bought[src] += qty
            order["n"] = self.broker_orders[src]
            self.broker_orders[src] += 1
            return (f"Ordered {qty:g}k gen {gen} GPUs from broker {src} for ${price:.1f}M (paid now), to {site}. Order #{order['id']}: "
                    f"the broker confirms delivery or cancellation at the end of month {self.t + 1}; if delivered, usable from month {self.t + 2}.")
        return (f"Ordered {qty:g}k gen {gen} GPUs for ${price:.1f}M (paid now), to {site}. Order #{order['id']} joins the vendor "
                f"{gen} queue; usable from month {self.t + MIN_LEAD} at the earliest.")

    def reserve(self, qty, months, site=None):
        site = self._site(site)
        if months not in TERM_FACTOR:
            raise ValueError("months must be 6, 12 or 24")
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._op()
        cap = RESERVE_CAP[self.regime[self.t]][site] - self.reserved_now[site]
        got = round(max(0.0, min(qty, cap)), 2)
        if got <= 0:
            return f"No reserved capacity available in {site} this month. (The operation is still used.)"
        price = self.term_price(months, site)
        self.reserved_now[site] += got
        self.contracts.append({"qty": got, "price": price, "start": self.t + 1, "end": self.t + 1 + months, "site": site})
        note = "" if got == qty else f" Providers in {site} could only fill {got:g} of the {qty:g} kH you asked for this month."
        return (f"Reserved {got:g} kH in {site} for {months} months at ${price:.3f}M per kH-month, months {self.t + 1}..{self.t + months}. "
                f"Committed: you pay for the full term even after month {T - 1}.{note}")

    def set_spot(self, qty, site=None):
        site = self._site(site)
        if qty < 0:
            raise ValueError("qty must be >= 0")
        self._op()
        self.spot_level[site] = qty
        return f"Standing spot request in {site} set to {qty:g} kH per month (filled at month end as far as {site} spot supply allows)."

    def contract_power(self, mw, site=None):
        site = self._site(site)
        if not 0 < mw <= 100:
            raise ValueError("mw must be in (0, 100]")
        self._op()
        n = sum(1 for p in self.power if p["site"] == site)
        lead = self.power_leads[site][n % len(self.power_leads[site])]
        self.power.append({"mw": mw, "start": self.t + lead, "end": self.t + lead + POWER_TERM, "site": site})
        return (f"Signed {mw:g} MW of colocation power in {site}. Energisation date: month {self.t + lead}. You pay "
                f"${POWER_COST[site]}M/MW-month from then for {POWER_TERM} months (obligation past month {T - 1} is charged at settlement).")

    def resell_gpus(self, qty, gen="H", site=None):
        site = self._site(site)
        if gen not in ("H", "N"):
            raise ValueError("gen must be H or N")
        if not 0 < qty <= self.owned[site][gen] + 1e-9:
            raise ValueError(f"you own {self.owned[site][gen]:g}k gen {gen} delivered GPUs in {site}")
        if self.resold[gen] + qty > RESELL_CAP + 1e-9:
            raise ValueError(f"the used market absorbs at most {RESELL_CAP:g}k per generation per month ({self.resold[gen]:g}k sold so far)")
        self._op()
        income = qty * RESALE * self.market_value(gen)
        self.cash += income
        self.owned[site][gen] -= qty
        self.resold[gen] += qty
        self.cost["resale"] -= income
        return f"Sold {qty:g}k gen {gen} GPUs in {site} for ${income:.1f}M."

    def move_gpus(self, qty, gen, frm, to):
        frm, to = self._site(frm), self._site(to)
        if gen not in ("H", "N"):
            raise ValueError("gen must be H or N")
        if frm == to:
            raise ValueError("from and to must differ")
        if not 0 < qty <= self.owned[frm][gen] + 1e-9:
            raise ValueError(f"you own {self.owned[frm][gen]:g}k gen {gen} delivered GPUs in {frm}")
        if self.moved_now + qty > MOVE_CAP + 1e-9:
            raise ValueError(f"at most {MOVE_CAP:g}k GPUs can be moved per month ({self.moved_now:g}k so far)")
        cost = qty * MOVE_COST
        self._pay(cost)
        self._op()
        self.cash -= cost
        self.cost["moves"] += cost
        self.owned[frm][gen] -= qty
        self.moved_now += qty
        self.moves.append({"gen": gen, "qty": qty, "to": to, "arrive": self.t + 1})
        return f"Shipping {qty:g}k gen {gen} GPUs from {frm} to {to} for ${cost:.1f}M; they arrive for month {self.t + 1}."

    def buy_option(self, qty):
        if not 0 < qty:
            raise ValueError("qty must be positive")
        if self.options_now + qty > OPTION_CAP + 1e-9:
            raise ValueError(f"at most {OPTION_CAP:g} kH of options per month ({self.options_now:g} so far)")
        cost = qty * OPTION_PREMIUM
        self._pay(cost)
        self._op()
        self.cash -= cost
        self.cost["options"] += cost
        self.options += qty
        self.options_now += qty
        return (f"Bought options on {qty:g} kH for ${cost:.1f}M. You now hold {self.options:g} kH of options: each can start a "
                f"{OPTION_TERM}-month reservation at ${OPTION_STRIKE}M per kH-month at any site, outside the reservation caps, until month {T - 1}.")

    def exercise_option(self, qty, site=None):
        site = self._site(site)
        if not 0 < qty <= self.options + 1e-9:
            raise ValueError(f"you hold {self.options:g} kH of options")
        self._op()
        self.options -= qty
        self.contracts.append({"qty": qty, "price": OPTION_STRIKE, "start": self.t + 1, "end": self.t + 1 + OPTION_TERM, "site": site, "option": True})
        return (f"Exercised {qty:g} kH of options in {site}: reserved months {self.t + 1}..{self.t + OPTION_TERM} at ${OPTION_STRIKE}M per "
                f"kH-month (paid for the full term, even after month {T - 1}). {self.options:g} kH of options left.")

    # ------------------------------------------------------------ month end
    def powered(self, s, k, owned=None):
        owned = owned or self.owned[s]
        mw = sum(p["mw"] for p in self.power if p["site"] == s and p["start"] <= k < p["end"])
        n = min(owned["N"], mw / POWER_MW["N"])
        h = min(owned["H"], (mw - n * POWER_MW["N"]) / POWER_MW["H"])
        return mw, {"H": h, "N": n}

    def end_month(self):
        if self.t >= T:
            raise ValueError("the episode is over")
        k = self.t
        sites, sp = {}, self.spot_price(k)
        charges = {"power": 0.0, "contracts": 0.0, "spot": 0.0}
        for s in SITES:
            mw, pw = self.powered(s, k)
            own_c = sum(pw[g] * COMPUTE[g] for g in pw)
            reserved = sum(c["qty"] for c in self.contracts if c["site"] == s and c["start"] <= k < c["end"])
            spot = min(self.spot_level[s], self.spot_cap(s, k))
            capacity = own_c + reserved + spot
            dem = self.site_demand(s, k)
            served = min(dem, capacity)
            charges["power"] += mw * POWER_COST[s]
            charges["contracts"] += sum(c["qty"] * c["price"] for c in self.contracts if c["site"] == s and c["start"] <= k < c["end"])
            charges["spot"] += spot * sp * SITE_PRICE[s]
            self.cost["unserved"] += (dem - served) * UNSERVED_INFERENCE
            sites[s] = {"demand": round(dem, 2), "served": round(served, 2), "own_compute": round(own_c, 2), "power_mw": mw,
                        "powered": {g: round(v, 2) for g, v in pw.items()}, "reserved": round(reserved, 2),
                        "spot_requested": self.spot_level[s], "spot_filled": round(spot, 2), "capacity": round(capacity, 2),
                        "training": round(capacity - served, 2)}
        for key, v in charges.items():
            self.cost[key] += v
            self.cash -= v
        training = sum(x["training"] for x in sites.values())
        for a, d, target in MILESTONES:
            if d == k:
                self.met[d] = self.window_training(a, d) + training >= target - 1e-9
        shipped = {}
        for gen in ("H", "N"):
            a = ALLOC[gen][self.regime[k]] * self.alloc_noise[k][gen] * (EXPORT_ALLOC if gen == "H" and self.export_active(k) else 1.0)
            shipped[gen] = 0.0
            for o in self.queue:
                if o["src"] == "vendor" and o["gen"] == gen and o["left"] > 0 and k >= o["placed"] + MIN_LEAD - 1 and a > 0:
                    x = min(o["left"], a)
                    o["left"] -= x
                    a -= x
                    shipped[gen] += x
                    self.owned[o["site"]][gen] += x
        broker = []
        for o in self.queue:
            if o["src"] in BROKERS and o["placed"] + 1 == k:
                ok = self.broker_u[o["src"]][o["n"]] < self.broker_q(o["src"], k)
                if ok:
                    self.owned[o["site"]][o["gen"]] += o["qty"]
                else:
                    refund = BROKER_REFUND * o["paid"]
                    self.cash += refund
                    self.cost["capex"] -= refund
                o["left"] = 0.0
                broker.append({"id": o["id"], "src": o["src"], "gen": o["gen"], "qty": o["qty"], "placed": o["placed"],
                               "site": o["site"], "delivered": ok})
        self.queue = [o for o in self.queue if o["left"] > 1e-9]
        for m in self.moves:
            if m["arrive"] == k + 1:
                self.owned[m["to"]][m["gen"]] += m["qty"]
        self.moves = [m for m in self.moves if m["arrive"] > k + 1]
        interest = RATE * -self.cash if self.cash < 0 else -EARN * self.cash   # negative = earned
        self.cost["interest"] += interest
        self.cash -= interest
        self.history.append({"month": k, "inference_demand": self.demand[k], "served": round(sum(x["served"] for x in sites.values()), 2),
                             "own_compute": round(sum(x["own_compute"] for x in sites.values()), 2),
                             "reserved": round(sum(x["reserved"] for x in sites.values()), 2),
                             "spot_requested": round(sum(self.spot_level.values()), 2),
                             "spot_filled": round(sum(x["spot_filled"] for x in sites.values()), 2), "spot_price": round(sp, 3),
                             "capacity": round(sum(x["capacity"] for x in sites.values()), 2), "training": round(training, 2),
                             "shipped": {g: round(v, 2) for g, v in shipped.items()}, "broker": broker, "sites": sites,
                             "interest": round(interest, 2), "cash_end": round(self.cash, 2)})
        self.cash += FUNDING
        self.broker_bought = {b: 0.0 for b in BROKERS}
        self.t += 1
        self.ops = 0
        self.resold = {"H": 0.0, "N": 0.0}
        self.reserved_now = {s: 0.0 for s in SITES}
        self.moved_now = 0.0
        self.options_now = 0.0
        if self.t == T:
            self.settle()

    def settle(self):
        for o in self.queue:   # broker orders still unconfirmed at the end are cancelled with the usual refund
            if o["src"] in BROKERS:
                self.cost["capex"] -= BROKER_REFUND * o["paid"]
        held = {g: sum(self.owned[s][g] for s in SITES) + sum(m["qty"] for m in self.moves if m["gen"] == g)
                + sum(o["left"] for o in self.queue if o["gen"] == g and o["src"] == "vendor") for g in ("H", "N")}
        mark = sum(RESALE * self.market_value(g, T) * held[g] for g in ("H", "N"))
        obligations = sum(c["qty"] * c["price"] * (c["end"] - max(c["start"], T)) for c in self.contracts if c["end"] > T)
        obligations += sum(p["mw"] * POWER_COST[p["site"]] * (p["end"] - max(p["start"], T)) for p in self.power if p["end"] > T)
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
            "owned": {s: dict(self.owned[s]) for s in SITES},
            "power": [dict(p) for p in self.power],
            "queue": [{"id": o["id"], "gen": o["gen"], "ordered": o["qty"], "left": round(o["left"], 2), "placed": o["placed"],
                       "src": o["src"], "site": o["site"], "paid": o["paid"]} for o in self.queue],
            "contracts": [dict(c) for c in self.contracts if c["end"] > k],
            "spot_level": dict(self.spot_level), "options": self.options, "moves": [dict(m) for m in self.moves],
            "cash": round(self.cash, 2),
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
            return "EPISODE OVER. Settlement:\n" + "\n".join(f"  {k}: {v}" for k, v in s.items())
        k = self.t
        L = [f"=== Month {k} of 0..{T - 1} === operations left this month: {o['ops_left']}"]
        if o["history"]:
            h = o["history"][-1]
            L.append(f"Last month (month {h['month']}): inference demand {h['inference_demand']} kH, served {h['served']}; "
                     f"training {h['training']} kH-months. Vendor shipments received: H {h['shipped']['H']:g}k, N {h['shipped']['N']:g}k." +
                     "".join(f" Broker {e['src']} order #{e['id']} ({e['qty']:g}k gen {e['gen']} to {e['site']}): " +
                             ("DELIVERED." if e["delivered"] else f"CANCELLED, {BROKER_REFUND:.0%} refunded.") for e in h["broker"]) +
                     (f" Interest charged: ${h['interest']:g}M." if h["interest"] > 0 else f" Interest earned: ${-h['interest']:g}M." if h["interest"] < 0 else ""))
            for s in SITES:
                x = h["sites"][s]
                L.append(f"  {s}: demand {x['demand']} served {x['served']} | capacity {x['capacity']} = owned&powered {x['own_compute']} "
                         f"+ reserved {x['reserved']:g} + spot {x['spot_filled']:g} (requested {x['spot_requested']:g}) | training {x['training']}")
        L.append("Training runs (kH-months done / needed within months a..b): " + "; ".join(
            f"months {a}..{d}: {done:g} / {t:g}" + (" MET" if o["met"].get(d) else " MISSED" if d in o["met"] else "")
            for (a, d, t), done in zip(MILESTONES, o["window_training"])))
        L.append(f"Cash: ${o['cash']:.1f}M (credit line ${CREDIT:g}M; {RATE:.0%}/month interest on debt, {EARN:.2%}/month earned on a positive balance; +${FUNDING:g}M funding each month). "
                 f"Options held: {o['options']:g} kH.")
        L.append("Sites this month:")
        for s in SITES:
            mw, pw = self.powered(s, k)
            res = sum(c["qty"] for c in self.contracts if c["site"] == s and c["start"] <= k < c["end"])
            L.append(f"  {s}: GPUs H {o['owned'][s]['H']:.2f}k, N {o['owned'][s]['N']:.2f}k (powered H {pw['H']:.2f}k, N {pw['N']:.2f}k); "
                     f"power {mw:g} MW; reserved {res:g} kH; standing spot {o['spot_level'][s]:g} kH")
        L.append("Power contracts: " + "; ".join(f"{p['site']} {p['mw']:g} MW months {p['start']}..{p['end'] - 1}" for p in o["power"] if p["end"] > k))
        L.append("Reserved contracts: " + ("; ".join(f"{c['site']} {c['qty']:g} kH at ${c['price']:.3f}M months {c['start']}..{c['end'] - 1}"
                                                      for c in o["contracts"]) or "none"))
        L.append("Vendor queue (FIFO per generation): " + ("; ".join(
            f"#{q['id']} gen {q['gen']} {q['left']:g}k of {q['ordered']:g}k to {q['site']} (placed month {q['placed']})"
            for q in o["queue"] if q["src"] == "vendor") or "empty") + ". Broker orders awaiting confirmation: " + ("; ".join(
            f"#{q['id']} broker {q['src']} {q['ordered']:g}k gen {q['gen']} to {q['site']} (placed month {q['placed']})"
            for q in o["queue"] if q["src"] != "vendor") or "none") + ". GPUs in transit: " + ("; ".join(
            f"{m['qty']:g}k gen {m['gen']} to {m['to']} (arrive month {m['arrive']})" for m in o["moves"]) or "none"))
        p = o["prices"]
        L.append(f"Prices now: buy {', '.join(f'gen {g} ${v:g}M per 1k GPUs' for g, v in p['gpu'].items())} from the vendor, "
                 f"{', '.join(f'${v:g}M from broker {b}' for b, v in p['broker'].items())}; "
                 f"reserve per kH-month (x site price: us 1.0, eu 1.1, ap 0.95): 6m ${p['reserve'][6]}, 12m ${p['reserve'][12]}, 24m ${p['reserve'][24]}; "
                 f"spot ${p['spot']}M per kH-month (x site price); options ${OPTION_PREMIUM}M per kH, strike ${OPTION_STRIKE}M; "
                 f"used-market value per 1k GPUs: " + ", ".join(f"{g} ${v:g}M" for g, v in p["market_value"].items()) + ".")
        L.append("News: " + (" | ".join(o["news"]) or "(nothing notable)"))
        L.append("Spent so far ($M): " + ", ".join(f"{k_}: {v:g}" for k_, v in o["spent"].items()))
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
            "buy_gpus": lambda: self.buy_gpus(num(0), **buy_args(args[1:])),
            "reserve": lambda: self.reserve(num(0), int(args[1]), args[2] if len(args) > 2 else None),
            "set_spot": lambda: self.set_spot(num(0), args[1] if len(args) > 1 else None),
            "contract_power": lambda: self.contract_power(num(0), args[1] if len(args) > 1 else None),
            "resell_gpus": lambda: self.resell_gpus(num(0), args[1].upper(), args[2] if len(args) > 2 else None),
            "move_gpus": lambda: self.move_gpus(num(0), args[1].upper(), args[2], args[3]),
            "buy_option": lambda: self.buy_option(num(0)),
            "exercise_option": lambda: self.exercise_option(num(0), args[1] if len(args) > 1 else None),
        }
        if name not in table:
            raise ValueError(f"unknown command {name!r}")
        try:
            return table[name]()
        except IndexError:
            raise ValueError(f"missing argument for {name}")


def buy_args(rest):
    out = {"gen": None, "src": "vendor", "site": None}
    for a in rest:
        if a.upper() in ("H", "N"):
            out["gen"] = a.upper()
        elif a.upper() in BROKERS or a.lower() == "vendor":
            out["src"] = a.upper() if a.upper() in BROKERS else "vendor"
        elif a.lower() in SITES:
            out["site"] = a.lower()
        else:
            raise ValueError(f"unknown buy_gpus argument {a!r}: use H|N, vendor|A|B and a site ({', '.join(SITES)})")
    return out


ACTIONS = ("buy_gpus", "reserve", "set_spot", "contract_power", "resell_gpus", "move_gpus", "buy_option", "exercise_option", "end_month")

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
