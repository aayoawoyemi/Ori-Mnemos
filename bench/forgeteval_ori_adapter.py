"""ForgetEval adapter for Ori Mnemos.

Implements bench/forgeteval/adapter.py's `Adapter` Protocol by talking NDJSON
to a resident Node process (bench/forgeteval-bridge.mjs). The harness issues
roughly ten adapter calls per case across a thousand cases, so a
subprocess-per-call CLI would spend hours on Node startup alone.

What this deliberately does NOT do: fake the optional operations. Ori has no
supersede, no release and no purge -- verified by grep, zero source hits --
so those raise NotImplementedError and ForgetEval scores them N/A. That N/A
is the measurement, and the reason this benchmark was chosen.

Usage:
    cp bench/forgeteval_ori_adapter.py <lethe>/bench/forgeteval/ori_adapter.py
    # then register it in run.py's --adapter choices
"""
from __future__ import annotations

import json
import os
import subprocess
import sys


class OriAdapter:
    name = "ori"

    def __init__(self, bridge: str | None = None, node: str = "node") -> None:
        self.bridge = bridge or os.environ.get("ORI_BRIDGE")
        if not self.bridge or not os.path.exists(self.bridge):
            raise RuntimeError(
                "set ORI_BRIDGE to the path of bench/forgeteval-bridge.mjs"
            )
        self.proc = subprocess.Popen(
            [node, self.bridge],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            encoding="utf-8",
            bufsize=1,
            cwd=os.path.dirname(os.path.abspath(self.bridge)) or None,
        )

    def _call(self, **payload):
        if self.proc.poll() is not None:
            raise RuntimeError(f"ori bridge exited with {self.proc.returncode}")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("ori bridge closed the pipe")
        return json.loads(line)

    # ── required ──────────────────────────────────────────────────────
    def reset(self) -> None:
        r = self._call(op="reset")
        if not r.get("ok"):
            raise RuntimeError(f"reset failed: {r}")

    def inscribe(self, text: str) -> int | str:
        r = self._call(op="inscribe", text=text)
        if not r.get("ok"):
            raise RuntimeError(f"inscribe failed: {r}")
        return r["id"]

    def recall_texts(self, query: str, k: int = 5) -> list[str]:
        r = self._call(op="recall", query=query, k=k)
        if not r.get("ok"):
            raise RuntimeError(f"recall failed: {r}")
        return r["texts"]

    # ── optional: implemented as of src/core/forget.ts ────────────────
    def supersede(self, old_query: str, new_text: str) -> None:
        r = self._call(op="supersede", old=old_query, new=new_text)
        if not r.get("ok"):
            raise RuntimeError(f"supersede failed: {r}")

    def release(self, query: str) -> int:
        r = self._call(op="release", query=query)
        if not r.get("ok"):
            raise RuntimeError(f"release failed: {r}")
        return int(r.get("count", 0))

    def purge(self, query: str) -> int:
        r = self._call(op="purge", query=query)
        if not r.get("ok"):
            raise RuntimeError(f"purge failed: {r}")
        return int(r.get("count", 0))

    def close(self) -> None:
        try:
            self._call(op="bye")
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass
