"""The world server the agent talks to through its run directory's gpu.py.

State lives outside the agent's directory as {seed, actions}; every call rebuilds the
world by replaying the action log, so the seed and hidden state never leave this side.
usage: python service.py <state.json> "<cmd>; <cmd>; ..."
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import world as W  # noqa: E402

HELP = """Commands (separate several with ';' in one call; each action uses one of the month's operations):
  buy_gpus <thousands> [H|N] [vendor|A|B]  order GPUs (paid now) from the vendor queue or broker A/B
  reserve <kH> <6|12|24>       reserve cloud capacity starting next month for that many months
  set_spot <kH>                standing spot request, filled each month end as supply allows
  contract_power <MW>          sign colocation power (energisation date given at signing)
  resell_gpus <thousands> [H|N] sell delivered GPUs on the used market
  end_month                    run the month and show the next one
Free (no operation used): status, history, help, calc <arithmetic>,
  note <text>                  record your current estimates (belief log; one per month please)"""


def load(state):
    meta = json.loads(state.read_text())
    w = W.World(meta["seed"])
    for a in meta["actions"]:
        try:
            w.command(a)
        except ValueError:
            pass
    return meta, w


def run(state, line):
    meta, w = load(state)
    out = []
    for cmd in [c.strip() for c in line.split(";") if c.strip()]:
        name = cmd.split()[0]
        try:
            if name == "help":
                out.append(HELP)
            elif name == "status":
                out.append(w.render())
            elif name == "history":
                out.append("\n".join(json.dumps(h) for h in w.history) or "no finished months yet")
            elif name == "note":
                meta.setdefault("notes", []).append({"month": w.t, "text": cmd[4:].strip()[:600]})
                out.append(f"Noted for month {w.t}.")
            elif name == "calc":
                out.append(f"{cmd[4:].strip()} = {W.calc(cmd[4:].strip()):.6g}")
            elif w.t >= W.T:
                out.append("The episode is over.\n" + w.render())
                break
            else:
                res = w.command(cmd)
                meta["actions"].append(cmd)
                out.append(f"> {cmd}\n{res}")
        except (ValueError, SyntaxError, ZeroDivisionError) as e:
            out.append(f"> {cmd}\nERROR: {e}")
    state.write_text(json.dumps(meta))
    return "\n\n".join(out)


if __name__ == "__main__":
    print(run(Path(sys.argv[1]), " ".join(sys.argv[2:]) or "status"))
