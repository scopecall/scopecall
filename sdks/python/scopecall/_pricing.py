from __future__ import annotations

import datetime
import logging
import threading
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Update LAST_VERIFIED_DATE when refreshing this table.
# CI (test_pricing_freshness.py) fails if it's older than 90 days.
LAST_VERIFIED_DATE = datetime.date(2026, 5, 22)

# (input_cost_per_1k, output_cost_per_1k) in USD
_BUNDLED: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-4o": (0.0025, 0.010),
    "gpt-4o-mini": (0.00015, 0.00060),
    "gpt-4-turbo": (0.010, 0.030),
    "gpt-4-turbo-preview": (0.010, 0.030),
    "gpt-4": (0.030, 0.060),
    "gpt-3.5-turbo": (0.0005, 0.0015),
    "gpt-3.5-turbo-0125": (0.0005, 0.0015),
    # Anthropic
    "claude-opus-4-7": (0.015, 0.075),
    "claude-sonnet-4-6": (0.003, 0.015),
    "claude-haiku-4-5-20251001": (0.00025, 0.00125),
    "claude-3-5-sonnet-20241022": (0.003, 0.015),
    "claude-3-5-haiku-20241022": (0.00025, 0.00125),
    "claude-3-opus-20240229": (0.015, 0.075),
    "claude-3-sonnet-20240229": (0.003, 0.015),
    "claude-3-haiku-20240307": (0.00025, 0.00125),
    # Google
    "gemini-1.5-pro": (0.00125, 0.005),
    "gemini-1.5-flash": (0.000075, 0.0003),
    "gemini-2.0-flash": (0.0001, 0.0004),
}


@dataclass
class PricingTable:
    _table: dict[str, tuple[float, float]]
    _lock: threading.Lock

    def __init__(self) -> None:
        self._table = dict(_BUNDLED)
        self._lock = threading.Lock()

    def calculate(self, model: str, input_tokens: int, output_tokens: int) -> float:
        with self._lock:
            entry = self._table.get(model)
        if entry is None:
            # Try prefix match for versioned model names (e.g. "gpt-4o-2024-11-20")
            with self._lock:
                for key, val in self._table.items():
                    if model.startswith(key):
                        entry = val
                        break
        if entry is None:
            return 0.0
        input_cost, output_cost = entry
        return round(
            (input_tokens / 1000 * input_cost) + (output_tokens / 1000 * output_cost),
            6,
        )

    def update(self, model: str, input_per_1k: float, output_per_1k: float) -> None:
        with self._lock:
            self._table[model] = (input_per_1k, output_per_1k)
