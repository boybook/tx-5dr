import { describe, expect, it } from 'vitest';
import {
  GRID_FIELD_COLUMNS,
  GRID_SQUARE_COLUMNS,
  GRID_SQUARE_SWITCH_ALTITUDE,
  buildGridStatusData,
  getGridSquareBlend,
  gridSquareAt,
} from './maidenheadGridLayer';

function squareOffset(column: number, row: number): number {
  return (row * GRID_SQUARE_COLUMNS + column) * 4;
}

describe('buildGridStatusData', () => {
  it('marks worked squares and the confirmed ones among them', () => {
    const data = buildGridStatusData([
      { grid: 'PM01', count: 4, confirmedCount: 1 },
      { grid: 'AA00', count: 1, confirmedCount: 0 },
    ]);

    // PM01: field P=15, M=12; square 0,1.
    const pm01 = squareOffset(150, 121);
    expect(data.squares[pm01]).toBe(255);
    expect(data.squares[pm01 + 1]).toBe(255);
    const aa00 = squareOffset(0, 0);
    expect(data.squares[aa00]).toBe(255);
    expect(data.squares[aa00 + 1]).toBe(0);
    expect(data.squares[squareOffset(1, 0)]).toBe(0);
    expect(data.byGrid.get('PM01')).toEqual({ count: 4, confirmedCount: 1 });
  });

  it('aggregates fields: worked if any square is, confirmed if any square is', () => {
    const data = buildGridStatusData([
      { grid: 'PM01', count: 2, confirmedCount: 0 },
      { grid: 'PM95', count: 3, confirmedCount: 2 },
      { grid: 'OL72', count: 1, confirmedCount: 0 },
    ]);
    const pm = (12 * GRID_FIELD_COLUMNS + 15) * 4;
    expect(data.fields[pm]).toBe(255);
    expect(data.fields[pm + 1]).toBe(255);
    const ol = (11 * GRID_FIELD_COLUMNS + 14) * 4;
    expect(data.fields[ol]).toBe(255);
    expect(data.fields[ol + 1]).toBe(0);
  });

  it('ignores malformed grids and never reports more confirmed than worked', () => {
    const data = buildGridStatusData([
      { grid: 'ZZ99', count: 1, confirmedCount: 0 },
      { grid: 'JO22', count: 1, confirmedCount: 5 },
    ]);
    expect(data.byGrid.size).toBe(1);
    expect(data.byGrid.get('JO22')).toEqual({ count: 1, confirmedCount: 1 });
  });
});

describe('gridSquareAt', () => {
  it('finds the square under a point, including the edges of the map', () => {
    expect(gridSquareAt(31.23, 121.47)).toBe('PM01');
    expect(gridSquareAt(52.5, 13.4)).toBe('JO62');
    expect(gridSquareAt(-90, -180)).toBe('AA00');
    expect(gridSquareAt(90, 179.99)).toBe('RR99');
    expect(gridSquareAt(10, 180)).toBe('AK00');
    expect(gridSquareAt(Number.NaN, 0)).toBeNull();
  });
});

describe('getGridSquareBlend', () => {
  it('shows fields far out, squares close in, and blends around the switch altitude', () => {
    expect(getGridSquareBlend(2)).toBe(0);
    expect(getGridSquareBlend(0.3)).toBe(1);
    expect(getGridSquareBlend(GRID_SQUARE_SWITCH_ALTITUDE)).toBeCloseTo(0.5);
  });
});
