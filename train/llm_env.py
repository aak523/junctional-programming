"""GPU World as a one-message-per-month chat environment for a language model.

Each month the model sees the rules (SYSTEM) and one user message: the same month screen the Harbor agent sees,
a table of finished months and its own recent notes. It replies with ONE line of ';'-separated commands. The line
runs through service.execute, the exact code path Harbor's world server uses; `end_month` is always appended, so
every reply plays exactly one month. Reward is read from the world's own settlement, as the Harbor verifier does.

This module imports no LLM library. The world object stays private: callers only get strings and dicts.
"""
import hashlib
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import service  # noqa: E402
import world as W  # noqa: E402

_INTRO = 'You act only through `python gpu.py "<command>; <command>; ..."` (run `python gpu.py help`).'
_FREE = "`status`, `history`, `help`, `calc <arithmetic>` and `note <text>` are free."
_ACTIONS = "\n".join(line for line in service.HELP.splitlines()[1:]
                     if not line.startswith(("Free", "  note")))

REPLY_RULES = f"""
## How to reply
You play one month per message. Each message shows this month's screen, a table of your finished months and your
recent notes. Reply with exactly ONE line of commands separated by `;`, in this order:
`note <your estimates>; <up to 15 actions>; end_month`
- The note records your current estimates: P(tight supply), gen N launch month, export controls, broker reliability,
  inference growth, what the current training window still needs, and your plan. Do not put `;` inside the note.
- Actions (each uses one of the month's 15 operations):
{_ACTIONS}
- `end_month` runs the month; nothing after it is executed. If you leave it out, the month ends anyway.
- A rejected command is reported as ERROR and has no effect. Write nothing except the one line of commands.

Example reply:
note P(tight)=0.30 | launch m12 (P=0.40, 10-14) | export none seen | A rel 0.50, B rel 0.50 | growth now 8% P=0.70 | need 40 kH-m in 6 months for m0..7 | plan: buy us, power ap, spot us; buy_gpus 3 H vendor us; contract_power 8 ap; set_spot 1.5 us; end_month
"""


def _system():
    t = (ROOT / "TASK.md").read_text(encoding="utf-8")
    assert _INTRO in t and _FREE in t, "TASK.md intro changed; update train/llm_env.py"
    t = t.replace(_INTRO, "You act by replying with one line of commands (format at the end).")
    t = t.replace(_FREE, "`note <text>` is free.")
    return t.rstrip() + "\n" + REPLY_RULES


def _short():
    """The rules cut to the task statement: for a trained model, which no longer needs them (half the tokens per example)."""
    t = (ROOT / "TASK.md").read_text(encoding="utf-8")
    head = t.split("You act only through")[0].strip()
    return head + "\n" + REPLY_RULES


SYSTEM_FULL = _system()
# data-format tag stored in every record: the user message is the same under either system prompt
SYSTEM_SHA = hashlib.sha1(SYSTEM_FULL.encode()).hexdigest()[:12]
PROMPT = os.environ.get("GPUW_PROMPT", "full")
assert PROMPT in ("full", "short"), PROMPT
SYSTEM = _short() if PROMPT == "short" else SYSTEM_FULL
REMINDER = "Reply with one line: note ...; <actions>; end_month"
FREE_CMDS = ("status", "history", "help", "calc")
MAX_SEGMENTS = 25


def history_row(h, index):
    sh = h["shipped"]
    brokers = " ".join(f"{e['src']}#{e['id']} {e['qty']:g}k {'ok' if e['delivered'] else 'cancelled'}" for e in h["broker"]) or "-"
    return (f"{h['month']:>2} | {h['inference_demand']:5.2f} | {index:5.3f} | {h['spot_price']:5.3f} | {sh['H']:.2f}/{sh['N']:.2f} | "
            f"{h['spot_filled']:.2f}/{h['spot_requested']:.2f} | {h['training']:6.2f} | {h['cash_end']:7.1f} | {brokers}")


def build_user(render, rows, notes):
    """The month's user message, from strings only (the screen, finished-month rows, the agent's own notes)."""
    parts = [render]
    if rows:
        parts.append("Finished months (m | demand kH | 12m contract index $M | spot $M | vendor shipped H/N k | "
                     "spot filled/requested kH | training kH-m | cash at month end $M | broker orders):\n" + "\n".join(rows))
    if notes:
        parts.append("Your recent notes:\n" + "\n".join(f"m{m}: {text}" for m, text in notes))
    parts.append(REMINDER)
    return "\n\n".join(parts)


def parse(text):
    """Model reply -> (command segments to run, info). Never raises."""
    lines = [ln for ln in text.strip().splitlines() if not ln.strip().startswith("```")]
    segs = [s.strip() for s in ";".join(lines).split(";") if s.strip()]
    info = {"forced_end": True, "dropped_after_end": 0, "ignored_free": 0, "truncated": 0}
    out = []
    for i, s in enumerate(segs):
        name = s.split()[0]
        if name == "end_month":
            info["forced_end"] = False
            info["dropped_after_end"] = len(segs) - i - 1
            break
        if name in FREE_CMDS:
            info["ignored_free"] += 1
            continue
        out.append(s)
    if len(out) > MAX_SEGMENTS:
        info["truncated"] = len(out) - MAX_SEGMENTS
        out = out[:MAX_SEGMENTS]
    return out, info


def score(net_cost, oracle):
    """The Harbor verifier's reward (server.py)."""
    return 1.0 if net_cost <= oracle else max(0.0, oracle / net_cost)


class Episode:
    def __init__(self, seed):
        self.seed = seed
        self._w = W.World(seed)
        self.meta = {"seed": seed, "actions": [], "notes": []}
        self.rows = []
        self.errors = self.forced_ends = self.n_actions = 0
        self._index = self._w.observe()["prices"]["reserve"][12]

    @property
    def month(self):
        return self._w.t

    @property
    def done(self):
        return self._w.t >= W.T

    def user(self):
        firsts = {}
        for n in self.meta["notes"]:
            firsts.setdefault(n["month"], n["text"])
        notes = sorted(firsts.items())[-4:]
        return build_user(self._w.render(), self.rows, notes)

    def messages(self):
        return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": self.user()}]

    def step(self, text):
        """Play one month from a model reply. Returns what ran."""
        month = self.month
        segs, info = parse(text)
        n0 = len(self.meta["actions"])
        reply = service.execute(self.meta, self._w, "; ".join(segs)) if segs else ""
        executed = self.meta["actions"][n0:]
        errors = reply.count("ERROR:")
        self.errors += errors
        self.forced_ends += info["forced_end"]
        self.n_actions += len(executed)
        self.close_month()
        return {"month": month, "completion": text, "executed": list(executed), "errors": errors,
                "forced_end": info["forced_end"], "parse": info, "reply": reply}

    def act_direct(self, cmd):
        """For scripted policies: apply one action; raises ValueError like World.command, logs only on success."""
        res = self._w.command(cmd)
        self.meta["actions"].append(cmd)
        self.n_actions += 1
        return res

    def note(self, text):
        return service.execute(self.meta, self._w, "note " + text)

    def observe(self):
        """What a player can see (for scripted teachers only)."""
        return self._w.observe()

    def close_month(self):
        """End the month: the one code path for model steps and scripted teachers."""
        h_index = self._index
        service.execute(self.meta, self._w, "end_month")
        self.rows.append(history_row(self._w.history[-1], h_index))
        if not self.done:
            self._index = self._w.observe()["prices"]["reserve"][12]

    def result(self):
        s = self._w.settlement
        return {"net_cost": s["net_cost"], "milestones_met": s["milestones_met"], "settlement": s,
                "errors": self.errors, "forced_ends": self.forced_ends, "n_actions": self.n_actions}


# ---------------------------------------------------------------- teacher notes
_VERB = {"buy_gpus": "buy", "set_spot": "spot", "contract_power": "power", "reserve": "reserve", "move_gpus": "move",
         "resell_gpus": "resell", "exercise_option": "exercise", "buy_option": "options"}


def plan_of(cmds):
    items = set()
    for c in cmds:
        p = c.split()
        verb = _VERB.get(p[0], p[0])
        if p[0] == "buy_gpus" and p[-2] in W.BROKERS:
            verb = "broker" + p[-2]
        if p[0] == "move_gpus":
            items.add(f"move {p[3]}>{p[4]}")
        elif p[-1] in W.SITES:
            items.add(f"{verb} {p[-1]}")
        else:
            items.add(verb)
    return ", ".join(sorted(items)) or "hold"


def synth_note(bel, obs, cmds):
    """A belief-log note from the reference's posterior (policies.Bayes) after this month's update."""
    t = obs["month"]
    parts = [f"P(tight)={bel.b:.2f}"]
    if obs["launched"]:
        parts.append(f"gen N launched m{next(iter(bel.launch))}")
    else:
        live = {m: p for m, p in bel.launch.items() if p > 0.01}
        top = max(live, key=live.get)
        parts.append(f"launch m{top} (P={live[top]:.2f}, {min(live)}-{max(live)})")
    if bel.export_start is not None:
        end = bel.export_start + W.EXPORT_MONTHS - 1
        parts.append(f"export active m{bel.export_start}-{end}" if t <= end else f"export ended m{end}")
    elif t - bel.export_rumour <= 1:
        parts.append(f"export rumour m{bel.export_rumour}")
    else:
        parts.append("export none seen")
    parts.append(", ".join(f"{b} rel {p:.2f}" for b, p in bel.rel.items()))
    hi = W.GROWTH[1]
    p_hi = sum(p for (g, sw), p in bel.growth.items() if (g if sw is None or t < sw else W.GROWTH[1 - W.GROWTH.index(g)]) == hi)
    cur, p_cur = (hi, p_hi) if p_hi >= 0.5 else (W.GROWTH[0], 1 - p_hi)
    g_part = f"growth now {cur:.0%} P={p_cur:.2f}"
    p_sw = sum(p for (g, sw), p in bel.growth.items() if sw is not None and sw <= t)
    if p_sw > 0.3:
        g_part += f", switched P={p_sw:.2f}"
    parts.append(g_part)
    for (a, d, target), done in zip(W.MILESTONES, obs["window_training"]):
        if a <= t <= d:
            parts.append(f"need {max(0.0, target - done):.0f} kH-m in {d - t + 1} months for m{a}..{d}")
    parts.append("plan: " + plan_of(cmds))
    return " | ".join(parts)


def completion_of(note, cmds):
    return "; ".join(["note " + note, *cmds, "end_month"])
