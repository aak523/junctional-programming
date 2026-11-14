# GPU World in 3D

A replay of one 24-month game as a world you can orbit: three datacenter campuses that grow as GPUs
arrive and get powered, the supply chain (vendor + two brokers) feeding them, the balance sheet, and
what is still in transit.

```
python3 -m http.server 8731 --directory viz    # then open http://localhost:8731/
```

It needs a local server — ES modules do not load over `file://`. Everything else is vendored, so it
works offline.

## What you are looking at

| On screen | What it is |
|---|---|
| Solid towers on a pad | GPUs you own at that site, one tower per thousand. Lit = powered, dark = idle for want of power. A white band on top marks gen N (2 kH each, so they are twice as tall). |
| Floating slab | active reserved cloud capacity at that site |
| Amber slab | capacity from an exercised option (outside the reservation caps) |
| Thin pillars at the pad rim | spot capacity actually filled this month |
| Bar in front of the pad | inference served, then training, then any unserved demand in red; the white tick is demand |
| Box behind the pad | energised power (MW); the amber wireframe is power contracted but not yet live |
| Gems moving along the arcs | orders in transit, coloured by destination; they arrive the month the order clears |
| Ring burst at a pad | a broker order confirmed (green) or cancelled (red) |

The vendor hub turns red while export controls are in force, and relabels itself at the gen N launch.

Controls: drag to orbit, scroll to zoom, right-drag to pan, hover a pad for its numbers, space to
play/pause, arrow keys to step. **truth** reveals the state the player never sees — the supply regime,
the launch month, export controls, the growth switch and each broker's true reliability.

Deep links: `?run=fable5&m=12&truth=1&spin=0`.

## The data

`export_run.py` plays a game and writes one frame per month to `data/<key>.json`:

```
python3 viz/export_run.py                      # the default set + data/index.json
python3 viz/export_run.py policy reference 3   # any policy from policies.LADDER, any seed
python3 viz/export_run.py harbor harbor/jobs/<job>/<trial>/verifier/details.json
```

A Harbor trial is replayed exactly: `details.json` carries the world seed and the agent's ordered
action log, so re-running them through `world.py` reproduces the trial's own net cost, and the
agent's monthly `note` becomes the belief log in the panel. The scripted policies need `scipy`
(`uv venv && uv pip install scipy`); replaying a Harbor trial does not.

The default set is the Claude Fable 5 v4 trial ($1,141M), the reference policy on that same world
($746M), and the reference on evaluation seed 3 — so you can watch the same world played two ways.
