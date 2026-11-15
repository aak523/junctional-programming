# GPU World in 3D

A replay of one 24-month game on a globe you can orbit: three datacentre campuses that grow as GPUs
arrive and get powered, the shipping lanes from the fab and the two brokers that feed them, the
balance sheet, and what is still in transit.

The six places are real, and the distances between them are why the lanes look the way they do:

| | where | what it is |
|---|---|---|
| `us` | Ashburn | 50% of inference demand, cheap-ish power, the biggest reservation cap |
| `eu` | Frankfurt | 30% of demand, dearest power, a 1.10x price multiple |
| `ap` | Singapore | 20% of demand, cheapest power, fastest to energise, no starting hardware |
| vendor | Taiwan | list price, but you join one first-in-first-out allocation queue |
| broker A | Dubai | 1.10x, confirms or cancels at the end of the next month |
| broker B | Panama | 1.25x, same deal |

```
python3 -m http.server 8731 --directory viz    # then open http://localhost:8731/
```

It needs a local server — ES modules do not load over `file://`. Everything else is vendored, so it
works offline.

## What you are looking at

| On screen | What it is |
|---|---|
| The shed on a pad | one site. Its length is the compute you own there; the lit vent band along it is the part of that fleet with power, and the rest is idle in the dark. Rooftop plant appears as gen N moves in. |
| Thin pillars at the pad rim | spot capacity actually filled this month |
| Bar in front of the pad | inference served, then training, then any unserved demand in red; the white tick is demand |
| Gems moving the arcs | orders in transit, coloured by destination; they arrive the month the order clears, so a vendor order stuck behind the queue visibly crawls |
| Ring burst at a pad | a broker order confirmed (green) or cancelled (red) |
| The fab in Taiwan | a factory with two lines out front, one per generation. Every thousand GPUs is a block; orders stand in the order they were placed, and the month's realised allocation lies over the line as a green rail, reaching exactly as far as it got |
| The brokers | a shop each, with the price on the sign — `$` at 1.10x, `$$` at 1.25x. What you just bought stands on the forecourt, what resolves tonight on the counter, and the month's stamps out front: green standing, red tipped over |

The fab's chimneys band red and smoke red while export controls are in force, and it relabels itself
at the gen N launch. Each of these objects has its own bench — see [benches.html](benches.html).

Controls: drag to spin the globe, scroll to zoom, right-drag to pan, **fly to** to drop onto a
campus or the fab, hover a pad for its numbers, space to play/pause, arrow keys to step. **truth** reveals the state the player never sees — the supply regime,
the launch month, export controls, the growth switch and each broker's true reliability.

**theme** switches between the two versions: light-on-black, or ink-on-white — a white globe with
black land, coastlines and markers, no bloom and no tone mapping. The site and status colours keep
their identity in both, re-stepped for the surface they sit on. The toggle reloads the page with
`?theme=light` so every material is built in the right key; it keeps the run, month and truth state.

Deep links: `?run=fable5&m=12&truth=1&spin=0&go=ap&theme=light`.

The globe's coastlines are precomputed by `make_land.py` from Natural Earth
110m land into `data/land.json` (the command is at the top of that file). It only needs rerunning if
you want finer coastlines.

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
