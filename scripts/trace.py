"""Print one policy's trajectory on one seed. usage: python scripts/trace.py <policy> <seed>"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gpu_world"))   # the environment modules
import policies  # noqa: E402
import world as W  # noqa: E402

name, seed = sys.argv[1], int(sys.argv[2])
pol, stop = policies.LADDER[name]
w = W.World(seed)
p = pol(w) if getattr(pol, "needs_world", False) else pol()
print("hidden: regime", "".join(r[0] for r in w.regime), "launch", w.launch, "export", w.export, "brokers reliable", w.broker_reliable, "decay", w.broker_decay, "growth switch", w.growth_switch)
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
