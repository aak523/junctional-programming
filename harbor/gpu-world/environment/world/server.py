"""HTTP world server: the Harbor sidecar that holds the seed and hidden state.

The agent's container reaches it only over the network:
  POST /cmd      body = "<cmd>; <cmd>"   -> reply text (same commands as TASK.md)
  GET  /observe                          -> what a player can see, as JSON (used by the reference solution)
  POST /settle   body = {"token": ...}   -> plays out any remaining months, then scores (verifier only)
  GET  /health
Env: VERIFY_TOKEN, STATE_FILE (default /state/episode.json), WORLD_SEED (optional: by default a fresh random
48-bit seed is drawn at startup, so the world exists only inside this container; it is revealed after settlement),
JUDGE_KEY (optional: a fixed WORLD_SEED is published in the repo, which the agent could read; a private key turns it
into a private seed, the same one on every run with the same key).
"""
import hashlib
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import compare
import policies
import service
import world as W

TOKEN = os.environ["VERIFY_TOKEN"]
STATE = Path(os.environ.get("STATE_FILE", "/state/episode.json"))
LOCK = threading.Lock()

STATE.parent.mkdir(parents=True, exist_ok=True)
if not STATE.exists():   # a restart keeps the episode (and its seed)
    seed = int(os.environ.get("WORLD_SEED") or secrets.randbits(48))
    if os.environ.get("JUDGE_KEY"):
        seed = int.from_bytes(hashlib.sha256(f"{os.environ['JUDGE_KEY']}:{seed}".encode()).digest()[:6], "big")
    STATE.write_text(json.dumps({"seed": seed, "actions": []}))
META, WORLD = service.load(STATE)
SEED = META["seed"]
RESULT = None


def settle():
    """Final score in [0, 1] (world.score): the oracle's net cost / the agent's, capped at 1, times the share of
    training runs met. The oracle is LP-MPC on the true future; the scale also plays the reference, do-nothing and
    stop-early (the reference for 3 months, then nothing) on the same world, and the diagnosis compares the agent's
    game with the reference's."""
    global RESULT
    if RESULT is None:
        months_played = WORLD.t
        s = WORLD.finish()
        oracle = policies.play(policies.OracleMPC, SEED)["net_cost"]
        ref_world = compare.reference(SEED)
        base = {"reference": ref_world.settlement, "do_nothing": policies.play(policies.do_nothing, SEED),
                "stop_early": policies.play(policies.StopEarly, SEED, stop_after=3)}
        scale = {"oracle": oracle} | {k: v["net_cost"] for k, v in base.items()}
        scale |= {f"{k}_reward": round(W.score(v["net_cost"], oracle, v["milestones_met"]), 4) for k, v in base.items()}
        RESULT = {"reward": round(W.score(s["net_cost"], oracle, s["milestones_met"]), 4), "seed": SEED,
                  "net_cost": s["net_cost"], "months_played": months_played, "milestones_met": s["milestones_met"],
                  "settlement": s, "scale": scale, "diagnosis": compare.diagnose(WORLD, ref_world, META.get("notes", [])),
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
