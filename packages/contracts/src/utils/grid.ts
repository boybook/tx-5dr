const GRID_WHITESPACE_REGEX = /\s+/g;
const FOUR_CHARACTER_GRID_REGEX = /^[A-R]{2}[0-9]{2}$/;
const TWO_CHARACTER_GRID_REGEX = /^[A-R]{2}$/;

export function sanitizeGridInput(grid?: string | null): string {
  if (!grid) {
    return '';
  }

  return grid.toUpperCase().replace(GRID_WHITESPACE_REGEX, '');
}

export function getFourCharacterGrid(grid?: string | null): string | undefined {
  const normalized = sanitizeGridInput(grid);
  if (normalized.length < 4) {
    return undefined;
  }

  const fourCharacterGrid = normalized.slice(0, 4);
  return FOUR_CHARACTER_GRID_REGEX.test(fourCharacterGrid) ? fourCharacterGrid : undefined;
}

export function getTwoCharacterGrid(grid?: string | null): string | undefined {
  const normalized = sanitizeGridInput(grid);
  if (normalized.length < 2) {
    return undefined;
  }

  const twoCharacterGrid = normalized.slice(0, 2);
  return TWO_CHARACTER_GRID_REGEX.test(twoCharacterGrid) ? twoCharacterGrid : undefined;
}

export interface GridBounds {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  centerLon: number;
  centerLat: number;
}

export function getGridBounds(grid?: string | null): GridBounds | null {
  const normalized = sanitizeGridInput(grid);
  if (normalized.length < 2) {
    return null;
  }

  const lonField = normalized.charCodeAt(0) - 65;
  const latField = normalized.charCodeAt(1) - 65;

  if (lonField < 0 || lonField > 17 || latField < 0 || latField > 17) {
    return null;
  }

  let lonMin = lonField * 20 - 180;
  let lonMax = lonMin + 20;
  let latMin = latField * 10 - 90;
  let latMax = latMin + 10;

  if (normalized.length >= 4) {
    const lonSquare = Number.parseInt(normalized[2], 10);
    const latSquare = Number.parseInt(normalized[3], 10);
    if (!Number.isFinite(lonSquare) || !Number.isFinite(latSquare)) {
      return null;
    }

    lonMin += lonSquare * 2;
    lonMax = lonMin + 2;
    latMin += latSquare;
    latMax = latMin + 1;
  }

  if (normalized.length >= 6) {
    const lonSub = normalized.charCodeAt(4) - 65;
    const latSub = normalized.charCodeAt(5) - 65;
    if (lonSub < 0 || lonSub > 23 || latSub < 0 || latSub > 23) {
      return null;
    }

    lonMin += lonSub * (2 / 24);
    lonMax = lonMin + (2 / 24);
    latMin += latSub * (1 / 24);
    latMax = latMin + (1 / 24);
  }

  return {
    lonMin,
    lonMax,
    latMin,
    latMax,
    centerLon: (lonMin + lonMax) / 2,
    centerLat: (latMin + latMax) / 2,
  };
}
