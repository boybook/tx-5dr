const GRID_WHITESPACE_REGEX = /\s+/g;
const FOUR_CHARACTER_GRID_REGEX = /^[A-R]{2}[0-9]{2}$/;

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
