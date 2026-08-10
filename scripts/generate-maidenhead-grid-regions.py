#!/usr/bin/env python3
"""Generate the compact Maidenhead Grid region table used at runtime.

The generated table contains intersections for every four-character Grid, not
centre-point reverse geocoding. It requires pyshp and Shapely only when the
source data is refreshed; neither library ships with the application.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
from collections import defaultdict

import shapefile
from shapely.geometry import box, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree


SOURCE_VERSION = "Natural Earth 5.1.1"
MIN_AREA = 1e-12

# Natural Earth uses this non-ISO value for Taiwan. Keep the generated lookup
# aligned with the ISO code already used by the callsign/DXCC presentation.
COUNTRY_CODE_ALIASES = {"CN-TW": "TW"}


def get_value(record: dict, key: str) -> str:
    value = record.get(key)
    return value.strip() if isinstance(value, str) else ""


def normalize_country_code(country_code: str) -> str:
    return COUNTRY_CODE_ALIASES.get(country_code, country_code)


def load_features(path: pathlib.Path, country_field: str):
    reader = shapefile.Reader(str(path))
    features = []
    for shape_record in reader.iterShapeRecords():
        properties = shape_record.record.as_dict()
        country = normalize_country_code(get_value(properties, country_field))
        geometry = shape(shape_record.shape.__geo_interface__)
        if not country or country == "-99" or geometry.is_empty:
            continue
        features.append((geometry, country, properties))
    return features


def build_tree(features):
    geometries = [feature[0] for feature in features]
    return STRtree(geometries), features


def tree_matches(tree, features, rect):
    for index in tree.query(rect):
        geometry, value, properties = features[index]
        if geometry.intersects(rect):
            yield geometry, value, properties


def grid_name(lon_field: int, lat_field: int, lon_square: int, lat_square: int) -> str:
    return (
        chr(ord("A") + lon_field)
        + chr(ord("A") + lat_field)
        + str(lon_square)
        + str(lat_square)
    )


def grid_bounds(lon_field: int, lat_field: int, lon_square: int, lat_square: int):
    lon_min = lon_field * 20 + lon_square * 2 - 180
    lat_min = lat_field * 10 + lat_square - 90
    return box(lon_min, lat_min, lon_min + 2, lat_min + 1)


def escape_typescript(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")


def get_country_label(properties: dict, field: str, fallback: str) -> str:
    return get_value(properties, field) or fallback


def format_tuple(values) -> str:
    return "[" + ", ".join(values) + "]"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--admin0", required=True, type=pathlib.Path)
    parser.add_argument("--admin1", required=True, type=pathlib.Path)
    parser.add_argument("--subunits", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    country_features = load_features(args.admin0, "ISO_A2")
    state_features = load_features(args.admin1, "iso_a2")
    subunit_features = load_features(args.subunits, "SU_A3")
    country_tree, country_features = build_tree(country_features)
    state_tree, state_features = build_tree(state_features)
    subunit_tree, subunit_features = build_tree(subunit_features)

    country_labels = {}
    for _, country_code, properties in country_features:
        country_labels.setdefault(
            country_code,
            get_country_label(properties, "NAME_EN", country_code),
        )

    special_geometries = {}
    us_states = []
    for geometry, country_code, properties in state_features:
        if country_code != "US":
            continue
        subdivision_code = get_value(properties, "iso_3166_2")
        if subdivision_code == "US-AK":
            special_geometries[6] = geometry
        elif subdivision_code == "US-HI":
            special_geometries[110] = geometry
        else:
            us_states.append(geometry)
    special_geometries[291] = unary_union(us_states)

    uk_entity_codes = {"ENG": 223, "NIR": 265, "SCT": 279, "WLS": 294}
    for geometry, subunit_code, _ in subunit_features:
        entity_code = uk_entity_codes.get(subunit_code)
        if entity_code is not None:
            special_geometries[entity_code] = geometry
    special_features = [(geometry, code, {}) for code, geometry in special_geometries.items()]
    special_tree, special_features = build_tree(special_features)

    subdivisions = {}
    rows = {}
    for lon_field in range(18):
        for lat_field in range(18):
            for lon_square in range(10):
                for lat_square in range(10):
                    grid = grid_name(lon_field, lat_field, lon_square, lat_square)
                    rect = grid_bounds(lon_field, lat_field, lon_square, lat_square)
                    country_areas = defaultdict(float)
                    for geometry, country_code, _ in tree_matches(country_tree, country_features, rect):
                        area = geometry.intersection(rect).area
                        if area > MIN_AREA:
                            country_areas[country_code] += area
                    if not country_areas:
                        continue

                    country_subdivisions = defaultdict(set)
                    for geometry, country_code, properties in tree_matches(state_tree, state_features, rect):
                        if country_code not in country_areas:
                            continue
                        if geometry.intersection(rect).area <= MIN_AREA:
                            continue
                        subdivision_code = get_value(properties, "iso_3166_2")
                        if not subdivision_code:
                            continue
                        country_subdivisions[country_code].add(subdivision_code)
                        subdivisions.setdefault(
                            subdivision_code,
                            (
                                country_code,
                                get_country_label(properties, "name_en", subdivision_code),
                            ),
                        )

                    special_codes = []
                    for geometry, entity_code, _ in tree_matches(special_tree, special_features, rect):
                        if geometry.intersection(rect).area > MIN_AREA:
                            special_codes.append(entity_code)

                    grid_area = rect.area
                    rows[grid] = (
                        sorted(
                            (
                                country_code,
                                min(1000, round(area / grid_area * 1000)),
                                sorted(country_subdivisions[country_code]),
                            )
                            for country_code, area in country_areas.items()
                        ),
                        sorted(special_codes),
                    )

    country_ids = {code: index for index, code in enumerate(sorted(country_labels))}
    subdivision_ids = {code: index for index, code in enumerate(sorted(subdivisions))}
    lines = [
        "// Generated by scripts/generate-maidenhead-grid-regions.py. Do not edit by hand.",
        f"// Source: {SOURCE_VERSION} Admin-0 countries, Admin-1 states/provinces, and Admin-0 map subunits.",
        "",
        "export interface MaidenheadGridCountry {",
        "  code: string;",
        "  nameEn: string;",
        "}",
        "",
        "export interface MaidenheadGridSubdivision extends MaidenheadGridCountry {",
        "  countryCode: string;",
        "}",
        "",
        "// [country id, coverage in permille, subdivision ids].",
        "export type MaidenheadGridCountryRef = readonly [number, number, readonly number[]];",
        "// [country refs, explicitly mapped DXCC entity codes].",
        "export type MaidenheadGridRegionRef = readonly [readonly MaidenheadGridCountryRef[], readonly number[]];",
        "",
        "export const MAIDENHEAD_GRID_COUNTRIES: readonly MaidenheadGridCountry[] = [",
    ]
    for country_code in sorted(country_labels):
        name_en = country_labels[country_code]
        lines.append(
            "  {"
            f" code: '{escape_typescript(country_code)}',"
            f" nameEn: '{escape_typescript(name_en)}'"
            " },"
        )
    lines.extend(["] as const;", "", "export const MAIDENHEAD_GRID_SUBDIVISIONS: readonly MaidenheadGridSubdivision[] = ["])
    for subdivision_code in sorted(subdivisions):
        country_code, name_en = subdivisions[subdivision_code]
        lines.append(
            "  {"
            f" code: '{escape_typescript(subdivision_code)}',"
            f" countryCode: '{escape_typescript(country_code)}',"
            f" nameEn: '{escape_typescript(name_en)}'"
            " },"
        )
    lines.extend(["] as const;", "", "export const MAIDENHEAD_GRID_REGIONS: Readonly<Record<string, MaidenheadGridRegionRef>> = {"])
    for grid in sorted(rows):
        countries, special_codes = rows[grid]
        country_values = []
        for country_code, coverage, subdivision_codes in countries:
            subdivision_values = ", ".join(str(subdivision_ids[code]) for code in subdivision_codes)
            country_values.append(f"[{country_ids[country_code]}, {coverage}, [{subdivision_values}]]")
        special_values = ", ".join(str(code) for code in special_codes)
        lines.append(f"  {grid}: [[{', '.join(country_values)}], [{special_values}]],")
    lines.extend(["};", ""])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {args.output} with {len(rows)} populated grids.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
