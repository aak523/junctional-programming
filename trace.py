"""Print one policy's trajectory on one seed. usage: python trace.py <policy> <seed>"""
import sys

import policies
import world as W

name, seed = sys.argv[1], int(sys.argv[2])
pol, stop = policies.LADDER[name]
w = W.World(seed)
p = pol(w) if pol is policies.Clairvoyant else pol()
print("hidden: regime", "".join(r[0] for r in w.regime), "launch", w.launch, "export", w.export)
while w.t < W.T:
    acts = []
    if stop is None or w.t < stop:
        def act(c):
            acts.append(c)
            return w.command(c)
        try:
            p(w.observe(), act)
        except ValueError as e:
            acts.append(f"ERR {e}")
    w.end_month()
    h = w.history[-1]
    print(f"m{h['month']:>2} {w.regime[h['month']][0]} dem {h['inference_demand']:5.1f} cap {h['capacity']:5.1f} own {h['own_compute']:5.1f} res {h['reserved']:5.1f} "
          f"spot {h['spot_filled']:4.1f}/{h['spot_requested']:4.1f}@{h['spot_price']:.2f} train {h['training']:5.1f} ship {h['shipped']} | {'; '.join(acts)}")
print(w.settlement)
