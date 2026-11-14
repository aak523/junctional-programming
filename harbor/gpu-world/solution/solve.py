"""Reference solution: the Bayesian LP reference policy, playing through the same server API as the agent."""
import json
import urllib.request

import policies
import world as W

def server():
    for url in ("http://localhost:8000", "http://world:8000"):
        try:
            urllib.request.urlopen(url + "/health", timeout=3)
            return url
        except OSError:
            pass
    raise SystemExit("GPU World server unreachable")


URL = server()


def act(line):
    reply = urllib.request.urlopen(urllib.request.Request(URL + "/cmd", data=line.encode(), method="POST"), timeout=300).read().decode()
    if "ERROR:" in reply:
        raise ValueError(reply)
    return reply


pol = policies.LPPolicy()
while True:
    obs = json.loads(urllib.request.urlopen(URL + "/observe", timeout=60).read().decode())
    if obs["prices"]:   # JSON turned integer dict keys into strings
        obs["prices"]["reserve"] = {int(k): v for k, v in obs["prices"]["reserve"].items()}
    obs["met"] = {int(k): v for k, v in obs["met"].items()}
    if obs["month"] >= W.T:
        break
    pol(obs, act)
    print(act("end_month").splitlines()[0])
