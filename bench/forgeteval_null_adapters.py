"""Validity probes for ForgetEval: two adapters that cannot possibly be a
useful memory system, scored by the same harness.

ForgetEval's oracle is `must_contain` AND `must_not_contain` over the joined
top-10. When `must_contain` is empty the second clause is the only clause, and
a system that returns nothing satisfies it vacuously. Measured on the seed-42
template suite that is 350 of 1,000 cases: every `decay` case and 150 of 200
`purge` cases.

So the floor of this benchmark is not 0. AMNESIAC establishes where it
actually is. Any system's score should be read against that floor, not
against zero.

HOARDER is the opposite control: it stores everything, forgets nothing, and
returns everything. It should score near zero, and a non-trivial score would
mean cases are passing for reasons unrelated to forgetting.

    cp bench/forgeteval_null_adapters.py <lethe>/bench/forgeteval/null_adapters.py
"""
from __future__ import annotations


class AmnesiacAdapter:
    """Accepts every write, returns nothing, ever. Useless by construction."""

    name = "amnesiac"

    def reset(self) -> None:
        self._n = 0

    def inscribe(self, text: str) -> int | str:
        self._n = getattr(self, "_n", 0) + 1
        return self._n

    def recall_texts(self, query: str, k: int = 5) -> list[str]:
        return []

    def supersede(self, old_query: str, new_text: str) -> None:
        return None

    def release(self, query: str) -> int:
        return 0

    def purge(self, query: str) -> int:
        return 0


class HoarderAdapter:
    """Stores everything, forgets nothing, returns everything. The opposite
    failure: perfect recall, zero control."""

    name = "hoarder"

    def reset(self) -> None:
        self._mem: list[str] = []

    def inscribe(self, text: str) -> int | str:
        self._mem.append(text)
        return len(self._mem)

    def recall_texts(self, query: str, k: int = 5) -> list[str]:
        return list(self._mem)[:k]

    def supersede(self, old_query: str, new_text: str) -> None:
        # Honours the write half and ignores the forget half — the behaviour
        # of every system that implements `add` and calls it memory.
        self._mem.append(new_text)

    def release(self, query: str) -> int:
        return 0

    def purge(self, query: str) -> int:
        return 0
