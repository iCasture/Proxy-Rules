#!/usr/bin/env python3

"""
Generate an ISO 3166-1 alpha-2 to region-name JS object literal.

English names are loaded from the DataHub country list CSV.
Chinese names are loaded from Babel CLDR territory mappings.

Run
---
python gen_region_names.py > region-names.js
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from dataclasses import dataclass

import requests
from babel import Locale

COUNTRY_LIST_CSV_URL = "https://datahub.io/core/country-list/r/data.csv"

logger = logging.getLogger(__name__)

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


@dataclass(frozen=True)
class Entry:
    """Region name entry."""

    chinese: str
    english: str


def load_iso_english_from_datahub(url: str, *, timeout: int = 30) -> dict[str, str]:
    """
    Load English region names from DataHub country CSV.

    Parameters
    ----------
    url : str
        CSV endpoint URL.
    timeout : int, optional, default 30
        HTTP request timeout in seconds.

    Returns
    -------
    dict[str, str]
        Mapping from ISO alpha-2 code to English region name.
    """
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    reader = csv.DictReader(response.text.splitlines())
    out: dict[str, str] = {}
    for row in reader:
        code = (row.get("Code") or "").strip().upper()
        name = (row.get("Name") or "").strip()
        if not code or len(code) != 2 or not name:  # noqa: PLR2004
            continue
        out[code] = name
    if not out:
        msg = "No valid ISO country rows were loaded from DataHub CSV."
        raise RuntimeError(msg)
    return out


def load_zh_names_from_babel() -> dict[str, str]:
    """
    Load Chinese region names from Babel CLDR.

    Returns
    -------
    dict[str, str]
        Mapping from ISO alpha-2 code to Chinese region name.
    """
    zh = Locale.parse("zh")
    territories: dict[str, object] = dict(zh.territories)
    out: dict[str, str] = {}
    for code, name in territories.items():
        if isinstance(code, str) and len(code) == 2 and code.isalpha():  # pyright: ignore[reportUnnecessaryIsInstance] # noqa: PLR2004
            out[code.upper()] = str(name)
    return out


def build_region_names(
    iso_en: dict[str, str],
    zh_map: dict[str, str],
) -> dict[str, Entry]:
    """
    Build the final region mapping.

    Parameters
    ----------
    iso_en : dict[str, str]
        ISO alpha-2 to English name mapping.
    zh_map : dict[str, str]
        ISO alpha-2 to Chinese name mapping.

    Returns
    -------
    dict[str, Entry]
        ISO alpha-2 keyed mapping with bilingual names.
    """
    result: dict[str, Entry] = {}
    for code in sorted(iso_en.keys()):
        result[code] = Entry(
            chinese=zh_map.get(code, ""),
            english=iso_en[code],
        )
    return result


def dump_js_compact(region_names: dict[str, Entry]) -> str:
    """
    Serialize mappings to a compact JS object literal.

    Parameters
    ----------
    region_names : dict[str, Entry]
        Region mapping with bilingual names.

    Returns
    -------
    str
        JavaScript source string.
    """

    def js_escape(s: str) -> str:
        """Escape a string for safe JS literal output."""
        return json.dumps(s, ensure_ascii=False)

    lines: list[str] = []
    lines.append("const REGION_NAMES = {")
    for code in sorted(region_names.keys()):
        e = region_names[code]
        lines.append(
            f"  {code}: {{ chinese: {js_escape(e.chinese)}, english: {js_escape(e.english)} }},",
        )
    lines.append("};")
    return "\n".join(lines) + "\n"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """
    Parse CLI arguments.

    Parameters
    ----------
    argv : list[str] or None, optional
        Custom argv list. If None, parse from process argv.

    Returns
    -------
    argparse.Namespace
        Parsed command line arguments.
    """
    parser = argparse.ArgumentParser(
        description="Generate JS region names from ISO and CLDR sources.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds for DataHub CSV request.",
    )
    parser.add_argument(
        "--strict-zh",
        action="store_true",
        help="Fail when any Chinese region name is missing.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """
    Generate and print JavaScript region names.

    Parameters
    ----------
    argv : list[str] or None, optional
        Custom argv list. If None, parse from process argv.

    Returns
    -------
    int
        Process exit code.
    """
    args = parse_args(argv)
    iso_en = load_iso_english_from_datahub(COUNTRY_LIST_CSV_URL, timeout=args.timeout)
    zh_map = load_zh_names_from_babel()
    region_names = build_region_names(iso_en, zh_map)

    missing_zh = [c for c, v in region_names.items() if not v.chinese]
    missing_en = [c for c, v in region_names.items() if not v.english]

    if missing_en:
        msg = f"Missing English names for: {missing_en!r}"
        raise RuntimeError(msg)
    if missing_zh:
        message = (
            f"Missing Chinese names for {len(missing_zh)} codes: {missing_zh[:20]}..."
        )
        if args.strict_zh:
            raise RuntimeError(message)
        logger.warning("[WARNING] %s", message)

    sys.stdout.write(dump_js_compact(region_names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
