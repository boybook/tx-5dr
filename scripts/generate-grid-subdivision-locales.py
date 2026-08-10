#!/usr/bin/env python3
"""Generate localized Grid subdivision names from a pinned Unicode CLDR release.

Natural Earth determines Grid coverage and supplies ISO 3166-2 subdivision
codes. This script uses those codes to extract display names from CLDR. It is
intentionally offline at application runtime; the input XML files are only
needed when refreshing the generated locale resources.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as xml
from urllib.request import urlopen


CLDR_VERSION = "48.2"
CLDR_REVISION = "11299982335beb974c1c63c45265184e759c0f41"
CLDR_SOURCE_URL = "https://github.com/unicode-org/cldr/tree/release-48-2/common/subdivisions"
EXPECTED_SHA256 = {
    "en": "997a14da1144bb66f36a829db1783afe41f7529e33070afbe964bdd8e387b1d2",
    "zh": "4f875ffc235cba7c97092c95e4ccebb9805457bec159e37e0ef4b64abeda4cb8",
    "ja": "3e220ad56170802ec067d4d2836e1f98e62479293c19ee6dcbb451852eda4fe0",
}
CLDR_FILE_URLS = {
    locale: f"https://raw.githubusercontent.com/unicode-org/cldr/{CLDR_REVISION}/common/subdivisions/{locale}.xml"
    for locale in EXPECTED_SHA256
}
SUBDIVISION_CODE_RE = re.compile(r"\{ code: '([^']+)', countryCode: '[^']+', nameEn: '")
SEPARATORS = {"en": ", ", "zh": "、", "ja": "、"}

# These are deliberate product-display overrides, not claims inferred from
# Natural Earth's de facto country geometries. CN-X01~ is Natural Earth's
# non-standard code for the Paracel Islands and therefore has no CLDR entry.
CURATED_SUBDIVISION_NAMES = {
    "en": {"CN-X01~": "Paracel Islands"},
    "zh": {"CN-X01~": "西沙群岛"},
    "ja": {"CN-X01~": "西沙諸島"},
}
# Keep Grid country wording consistent with the product's callsign/DXCC view.
CURATED_COUNTRY_NAMES = {
    "zh": {"TW": "中国台湾"},
}


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_cldr_file(locale: str, output: pathlib.Path) -> None:
    with urlopen(CLDR_FILE_URLS[locale], timeout=30) as response:
        content = response.read()
    actual_sha256 = hashlib.sha256(content).hexdigest()
    expected_sha256 = EXPECTED_SHA256[locale]
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"Downloaded CLDR {locale}.xml does not match pinned SHA-256: "
            f"expected {expected_sha256}, got {actual_sha256}"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)


def resolve_cldr_input(
    locale: str,
    explicit_path: pathlib.Path | None,
    download_dir: pathlib.Path | None,
) -> pathlib.Path:
    if explicit_path is not None:
        return explicit_path
    if download_dir is None:
        raise ValueError(f"Provide --cldr-{locale} or --download-dir for CLDR {locale}.xml")

    output = download_dir / f"{locale}.xml"
    if not output.exists():
        download_cldr_file(locale, output)
    return output


def read_subdivision_codes(grid_table: pathlib.Path) -> list[str]:
    codes = sorted(set(SUBDIVISION_CODE_RE.findall(grid_table.read_text(encoding="utf-8"))))
    if not codes:
        raise ValueError(f"No subdivision codes found in {grid_table}")
    return codes


def read_cldr_names(path: pathlib.Path, locale: str) -> dict[str, str]:
    actual_sha256 = sha256(path)
    expected_sha256 = EXPECTED_SHA256[locale]
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"{path} does not match pinned CLDR {CLDR_VERSION} {locale}.xml: "
            f"expected {expected_sha256}, got {actual_sha256}"
        )

    names: dict[str, str] = {}
    root = xml.parse(path).getroot()
    for subdivision in root.findall("./localeDisplayNames/subdivisions/subdivision"):
        if "alt" in subdivision.attrib:
            continue
        code = subdivision.attrib.get("type")
        name = "".join(subdivision.itertext()).strip()
        if code and name:
            names[code.lower()] = name
    return names


def to_cldr_code(iso_3166_2_code: str) -> str:
    # CLDR stores ISO 3166-2 keys without the hyphen, for example CN-HL -> cnhl.
    return iso_3166_2_code.replace("-", "").lower()


def build_locale_document(locale: str, codes: list[str], cldr_names: dict[str, str], source_sha256: str) -> dict:
    subdivisions = {
        code: cldr_names[to_cldr_code(code)]
        for code in codes
        if to_cldr_code(code) in cldr_names
    }
    overrides = {
        code: name
        for code, name in CURATED_SUBDIVISION_NAMES.get(locale, {}).items()
        if code in codes
    }
    subdivisions.update(overrides)
    return {
        "_meta": {
            "source": f"Unicode CLDR {CLDR_VERSION}",
            "revision": CLDR_REVISION,
            "sourceUrl": CLDR_SOURCE_URL,
            "sourceSha256": source_sha256,
            "subdivisionCount": len(codes),
            "localizedCount": len(subdivisions),
            "fallbackCount": len(codes) - len(subdivisions),
            "curatedSubdivisionOverrideCount": len(overrides),
        },
        "countries": CURATED_COUNTRY_NAMES.get(locale, {}),
        "subdivisionSeparator": SEPARATORS[locale],
        "subdivisions": subdivisions,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grid-table", required=True, type=pathlib.Path)
    parser.add_argument("--cldr-en", type=pathlib.Path)
    parser.add_argument("--cldr-zh", type=pathlib.Path)
    parser.add_argument("--cldr-ja", type=pathlib.Path)
    parser.add_argument("--download-dir", type=pathlib.Path, help="Download the pinned CLDR XML files here when no --cldr-* path is supplied.")
    parser.add_argument("--output-dir", required=True, type=pathlib.Path)
    args = parser.parse_args()

    try:
        codes = read_subdivision_codes(args.grid_table)
        inputs = {
            "en": resolve_cldr_input("en", args.cldr_en, args.download_dir),
            "zh": resolve_cldr_input("zh", args.cldr_zh, args.download_dir),
            "ja": resolve_cldr_input("ja", args.cldr_ja, args.download_dir),
        }
        for locale, path in inputs.items():
            cldr_names = read_cldr_names(path, locale)
            document = build_locale_document(locale, codes, cldr_names, sha256(path))
            output = args.output_dir / locale / "grid-regions.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            metadata = document["_meta"]
            print(
                f"Wrote {output}: {metadata['localizedCount']}/{metadata['subdivisionCount']} "
                f"localized names ({metadata['curatedSubdivisionOverrideCount']} curated overrides); "
                f"{metadata['fallbackCount']} use the Natural Earth English fallback."
            )
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
