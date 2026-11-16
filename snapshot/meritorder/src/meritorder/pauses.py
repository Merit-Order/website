"""How often sessions pause long enough to lose a 5-minute cache but not an hour's (decision 60, docs/03-routing.md).

A Claude backend set to an hour (decision 53) costs more per write than a 5-minute one, and saves a rebuild each time a
session comes back after 5 to 60 minutes. ``Router.estimate`` counts that saving from the share of later turns that
came after such a pause, observed on this gateway's own sessions: by team where a team has enough turns, else across
the organization, else a prior. Only counts are kept: turns, and turns after a pause, per team.

Each gateway counts its own turns and saves them every minute in the store's ``session_pauses`` setting under its own
id; every gateway reads the sum. Counts halve every ``HALF_LIFE`` seconds, so the share follows how people work now.
"""

from __future__ import annotations

import math
import time
import uuid

SETTING = "session_pauses"
LOW, HIGH = 300.0, 3600.0  # a pause of at least 5 minutes (the short cache is gone) and under an hour (the long one isn't)
PRIOR = 0.10  # the share before there's data: a person reads, tests or steps away about one turn in ten
PSEUDO = 100.0  # the prior counts as this many turns, and so does the organization's share for a team's
HALF_LIFE = 7 * 86400.0
STALE = 30 * 86400.0  # a gateway's counts not saved for this long are dropped (it's gone)


class Pauses:
    """Turns, and turns after a 5-60 minute pause, per team: this process's and (loaded) every other gateway's."""

    def __init__(self, gateway_id: str | None = None) -> None:
        self.id = gateway_id or uuid.uuid4().hex[:12]
        self.own: dict[str, list[float]] = {}  # team -> [turns, paused], decayed to ``at``
        self.at = time.time()
        self.others: dict[str, list[float]] = {}  # every other gateway's, summed, as last loaded
        self.dirty = False

    def _decay(self, now: float) -> None:
        f = 0.5 ** (max(now - self.at, 0.0) / HALF_LIFE)
        if f < 1.0:
            for c in self.own.values():
                c[0] *= f
                c[1] *= f
        self.at = now

    def observe(self, team: str, gap: float, now: float | None = None) -> None:
        """A session's later turn, ``gap`` seconds after its last one."""
        if gap <= 0:
            return
        self._decay(now or time.time())
        c = self.own.setdefault(team, [0.0, 0.0])
        c[0] += 1
        if LOW <= gap < HIGH:
            c[1] += 1
        self.dirty = True

    def counts(self, team: str | None = None) -> tuple[float, float]:
        teams = [team] if team is not None else sorted(set(self.own) | set(self.others))
        turns = sum(self.own.get(t, [0, 0])[0] + self.others.get(t, [0, 0])[0] for t in teams)
        paused = sum(self.own.get(t, [0, 0])[1] + self.others.get(t, [0, 0])[1] for t in teams)
        return turns, paused

    def share(self, team: str) -> float:
        """The expected share of a session's later turns that come after a 5-60 minute pause: the team's own, shrunk
        towards the organization's, which is shrunk towards ``PRIOR`` (each counting as ``PSEUDO`` turns)."""
        turns, paused = self.counts()
        org = (paused + PSEUDO * PRIOR) / (turns + PSEUDO)
        t_turns, t_paused = self.counts(team)
        return (t_paused + PSEUDO * org) / (t_turns + PSEUDO)

    def describe(self, team: str) -> dict:
        turns, paused = self.counts(team)
        return {"share": round(self.share(team), 4), "turns": round(turns), "paused": round(paused), "prior": PRIOR}

    def load(self, doc: dict | None, now: float | None = None) -> None:
        """Every other gateway's counts from the stored setting, decayed to now; this process's own entry is skipped."""
        now = now or time.time()
        others: dict[str, list[float]] = {}
        for gid, entry in ((doc or {}).get("gateways") or {}).items():
            age = now - float(entry.get("at") or 0)
            if gid == self.id or age > STALE:
                continue
            f = 0.5 ** (max(age, 0.0) / HALF_LIFE)
            for team, (t, p) in (entry.get("teams") or {}).items():
                c = others.setdefault(team, [0.0, 0.0])
                c[0] += float(t) * f
                c[1] += float(p) * f
        self.others = others

    def merged(self, doc: dict | None, now: float | None = None) -> dict:
        """The setting with this process's counts in it, and gateways gone for STALE dropped."""
        now = now or time.time()
        self._decay(now)
        gateways = {g: e for g, e in ((doc or {}).get("gateways") or {}).items() if now - float(e.get("at") or 0) <= STALE}
        gateways[self.id] = {"at": now, "teams": {t: [round(c[0], 3), round(c[1], 3)] for t, c in self.own.items()
                                                  if not math.isclose(c[0], 0.0)}}
        return {"gateways": gateways}
