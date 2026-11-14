"""HTTP world server: the Harbor sidecar that holds the seed and hidden state.

The agent's container reaches it only over the network:
  POST /cmd      body = "<cmd>; <cmd>"   -> reply text (same commands as TASK.md)
  GET  /observe                          -> what a player can see, as JSON (used by the reference solution)
  POST /settle   body = {"token": ...}   -> plays out any remaining months, then scores (verifier only)
  GET  /health
Env: WORLD_SEED, VERIFY_TOKEN, STATE_FILE (default /state/episode.json).
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import policies
import service

SEED = int(os.environ["WORLD_SEED"])
TOKEN = os.environ["VERIFY_TOKEN"]
STATE = Path(os.environ.get("STATE_FILE", "/state/episode.json"))
LOCK = threading.Lock()

STATE.parent.mkdir(parents=True, exist_ok=True)
if not STATE.exists():
    STATE.write_text(json.dumps({"seed": SEED, "actions": []}))
META, WORLD = service.load(STATE)
RESULT = None


def score(net_cost, oracle):
    return 1.0 if net_cost <= oracle else max(0.0, oracle / net_cost)


def settle():
    """Final score in [0, 1]: the oracle's net cost / the agent's net cost, i.e. the fraction of perfect-information
    efficiency achieved (the oracle is LP-MPC on the true future; doing nothing scores about 0.2)."""
    global RESULT
    if RESULT is None:
        months_played = WORLD.t
        s = WORLD.finish()
        dn = policies.play(policies.do_nothing, SEED)["net_cost"]
        oracle = policies.play(policies.OracleMPC, SEED)["net_cost"]
        reference = policies.play(policies.LPPolicy, SEED)["net_cost"]
        reward = score(s["net_cost"], oracle)
        RESULT = {"reward": round(reward, 4), "net_cost": s["net_cost"], "months_played": months_played,
                  "milestones_met": s["milestones_met"], "settlement": s,
                  "scale": {"oracle": oracle, "reference": reference, "do_nothing": dn,
                            "reference_reward": round(score(reference, oracle), 4), "do_nothing_reward": round(score(dn, oracle), 4)},
                  "notes": META.get("notes", []), "actions": META["actions"]}
    return RESULT


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/plain"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0) or 0)).decode("utf-8", "replace")[:20000]

    def do_GET(self):
        with LOCK:
            if self.path == "/health":
                self._send(200, "ok")
            elif self.path == "/observe":
                self._send(200, json.dumps(WORLD.observe()), "application/json")
            else:
                self._send(404, "use the gpu command")

    def do_POST(self):
        with LOCK:
            if self.path == "/cmd":
                if RESULT is not None:
                    self._send(200, "The episode has been settled.")
                    return
                out = service.execute(META, WORLD, self._body() or "status")
                STATE.write_text(json.dumps(META))
                self._send(200, out)
            elif self.path == "/settle":
                try:
                    ok = json.loads(self._body()).get("token") == TOKEN
                except (ValueError, AttributeError):
                    ok = False
                if not ok:
                    self._send(403, "forbidden")
                else:
                    self._send(200, json.dumps(settle()), "application/json")
            else:
                self._send(404, "use the gpu command")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
