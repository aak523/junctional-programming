"""Verda (ex-DataCrunch) GPU box for training. Credentials come from VERDA_CLIENT_ID / VERDA_CLIENT_SECRET in the
environment, else from the repository's gitignored .env; they are never printed or sent to the box.

usage: python train/cloud/box.py status            balance, H100/A100 availability, our instances
       python train/cloud/box.py up [--type T] [--location L]
       python train/cloud/box.py down              delete every gpu-world-train instance and confirm
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOST = "gpu-world-train"
IMAGE = "24.04.cuda13.2"   # driver new enough for any PyTorch wheel's bundled CUDA runtime
# on-demand only, in order of value for a 4B LoRA run ($/h: 5.24, 5.24, 6.70, 2.39, 2.84, 9.51)
TYPES = ["1H100.80S.30V", "1H100.80S.32V", "1H200.141S.44V", "1A100.22V", "1RTXPRO6000.30V", "1B200.30V"]
LOCATIONS = ["FIN-01", "FIN-02", "FIN-03"]
PUBKEY = Path.home() / ".ssh" / "id_ed25519.pub"


def _env_files():
    yield HERE.parents[1] / ".env"
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=HERE,
                            capture_output=True, text=True).stdout.strip()
    if common:
        yield Path(common).parent / ".env"   # the main worktree


def creds():
    vals = {k: os.environ.get(k) for k in ("VERDA_CLIENT_ID", "VERDA_CLIENT_SECRET")}
    for f in _env_files():
        if all(vals.values()) or not f.exists():
            continue
        for line in f.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() in vals and not vals[k.strip()]:
                vals[k.strip()] = v.strip().strip('"').strip("'")
    if not all(vals.values()):
        sys.exit("VERDA_CLIENT_ID / VERDA_CLIENT_SECRET not found in the environment or .env")
    return vals["VERDA_CLIENT_ID"], vals["VERDA_CLIENT_SECRET"]


def client():
    from verda import VerdaClient
    return VerdaClient(*creds())


def ours(c):
    return [i for i in c.instances.get() if i.hostname.startswith(HOST) and i.status != "deleted"]


def status(c):
    b = c.balance.get()
    print(f"balance: {b.amount:.2f} {b.currency}")
    prices = {t.instance_type: t.price_per_hour for t in c.instance_types.get()}
    for t in TYPES:
        if t in prices:
            avail = [loc for loc in LOCATIONS if c.instances.is_available(t, False, loc)]
            print(f"{t}: ${prices[t]}/h on-demand, available in {avail or 'none'}")
    print("H100/A100 types listed:", sorted(t for t in prices if "H100" in t or "A100" in t))
    for i in ours(c):
        print(f"instance {i.id} {i.hostname} {i.status} {i.ip} {i.location} {i.instance_type}")


def up(c, itype, location):
    if ours(c):
        sys.exit("a gpu-world-train instance already exists; run status or down")
    choices = [(t, loc) for t in ([itype] if itype else TYPES) for loc in ([location] if location else LOCATIONS)]
    pick = next(((t, loc) for t, loc in choices if c.instances.is_available(t, False, loc)), None)
    if not pick:
        sys.exit("no on-demand capacity for " + ", ".join(t for t, _ in choices))
    key = PUBKEY.read_text().strip()
    keys = [k for k in c.ssh_keys.get() if k.public_key.strip() == key]
    key_id = keys[0].id if keys else c.ssh_keys.create("gpu-world-train", key).id
    script = c.startup_scripts.create(f"gpu-world-setup-{int(time.time())}", (HERE / "startup.sh").read_text())
    print(f"creating {pick[0]} in {pick[1]} ...", flush=True)
    inst = c.instances.create(instance_type=pick[0], image=IMAGE, hostname=HOST, description="GPU World fine-tuning",
                              ssh_key_ids=[key_id], location=pick[1], startup_script_id=script.id,
                              os_volume={"name": HOST + "-os", "size": 200}, is_spot=False, max_wait_time=900)
    for _ in range(180):
        inst = c.instances.get_by_id(inst.id)
        if inst.status == "running" and inst.ip:
            break
        time.sleep(5)
    print(f"instance {inst.id} {inst.status} ip {inst.ip}\nssh root@{inst.ip}")
    (HERE / "box_ip").write_text(str(inst.ip or ""))


def down(c):
    from verda.constants import Actions
    for i in ours(c):
        print(f"deleting {i.id} {i.hostname} ({i.status})", flush=True)
        c.instances.action(i.id, Actions.DELETE, delete_permanently=True)
    for _ in range(60):
        left = ours(c)
        if not left:
            print("no gpu-world-train instances remain")
            return
        time.sleep(5)
    sys.exit(f"still present: {[(i.id, i.status) for i in left]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "up", "down"])
    ap.add_argument("--type")
    ap.add_argument("--location")
    a = ap.parse_args()
    c = client()
    {"status": lambda: status(c), "up": lambda: up(c, a.type, a.location), "down": lambda: down(c)}[a.cmd]()
