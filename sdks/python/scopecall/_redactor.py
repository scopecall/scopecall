from __future__ import annotations

import re
from dataclasses import dataclass


def _luhn_check(number: str) -> bool:
    digits = [int(d) for d in number if d.isdigit()]
    odd_digits = digits[-1::-2]
    even_digits = digits[-2::-2]
    total = sum(odd_digits)
    for d in even_digits:
        total += sum(divmod(d * 2, 10))
    return total % 10 == 0


@dataclass
class _Pattern:
    name: str
    regex: re.Pattern[str]
    replacement: str
    luhn_check: bool = False


# Order matters: EMAIL/CARD/SSN/IP must run before PHONE to avoid partial matches
_DEFAULT_PATTERNS: list[_Pattern] = [
    _Pattern(
        name="EMAIL",
        regex=re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
        replacement="[EMAIL]",
    ),
    _Pattern(
        name="CARD",
        regex=re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b"),
        replacement="[CARD]",
        luhn_check=True,
    ),
    _Pattern(
        name="SSN",
        regex=re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
        replacement="[SSN]",
    ),
    _Pattern(
        name="IP",
        regex=re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
        replacement="[IP]",
    ),
    _Pattern(
        name="PHONE",
        regex=re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b"),
        replacement="[PHONE]",
    ),
]


class Redactor:
    def __init__(self) -> None:
        self._patterns: list[_Pattern] = list(_DEFAULT_PATTERNS)

    def add_pattern(self, name: str, regex: str, replacement: str | None = None) -> None:
        compiled = re.compile(regex)
        tag = replacement or f"[{name.upper()}]"
        self._patterns.append(_Pattern(name=name, regex=compiled, replacement=tag))

    def redact(self, text: str) -> str:
        for pattern in self._patterns:
            if pattern.luhn_check:
                text = self._redact_with_luhn(text, pattern)
            else:
                text = pattern.regex.sub(pattern.replacement, text)
        return text

    def _redact_with_luhn(self, text: str, pattern: _Pattern) -> str:
        def replace(m: re.Match[str]) -> str:
            digits_only = re.sub(r"[-\s]", "", m.group())
            if _luhn_check(digits_only):
                return pattern.replacement
            return m.group()

        return pattern.regex.sub(replace, text)
