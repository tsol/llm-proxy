"""Text normalization for Orpheus (English-centric TTS)."""

from __future__ import annotations

import re

_CYRILLIC = re.compile(r"[\u0400-\u04FF]")


def contains_cyrillic(text: str) -> bool:
    return bool(_CYRILLIC.search(text))


def transliterate_russian_to_latin(text: str) -> str:
    """Map Cyrillic → Latin (ISO-style). Orpheus has no Russian grapheme model."""
    try:
        from transliterate import translit
    except ImportError:
        return text
    return translit(text, "ru", reversed=True)


def prepare_text_for_orpheus(text: str, transliterate: bool = True) -> tuple[str, bool]:
    """Return (text_for_prompt, was_transliterated)."""
    if not transliterate or not contains_cyrillic(text):
        return text, False
    return transliterate_russian_to_latin(text), True
