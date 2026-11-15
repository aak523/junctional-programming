"""Ask the world server to settle the episode; write the 0..1 reward and the details."""
import json
import urllib.request

def server():
    for url in ("http://localhost:8000", "http://world:8000"):
        try:
            urllib.request.urlopen(url + "/health", timeout=3)
            return url
        except OSError:
            pass
    raise SystemExit("GPU World server unreachable")


req = urllib.request.Request(server() + "/settle", data=json.dumps({"token": "31663904c2ae1e1364004fc1b0ce9e2232434aed0828c452"}).encode(), method="POST")
res = json.loads(urllib.request.urlopen(req, timeout=500).read().decode())
open("/logs/verifier/details.json", "w").write(json.dumps(res, indent=1))
open("/logs/verifier/reward.txt", "w").write(f"{res['reward']:.4f}\n")
print(json.dumps({k: res[k] for k in ("reward", "net_cost", "months_played", "milestones_met", "scale")}, indent=1))
print("Mistake report (the agent's game vs the reference's on this world):")
print("\n".join("- " + x for x in res["diagnosis"]["findings"]))
