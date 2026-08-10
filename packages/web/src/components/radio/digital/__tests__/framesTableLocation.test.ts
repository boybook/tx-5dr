import { describe, expect, it } from 'vitest';
import { resolveFrameLocationDisplay, type FrameDisplayMessage } from '../FramesTable';

function createMessage(overrides: Partial<FrameDisplayMessage>): FrameDisplayMessage {
  return {
    utc: '12:00:00',
    db: -10,
    dt: 0.1,
    freq: 1000,
    message: '<...> BG5DRB RR73',
    ...overrides,
  };
}

describe('frame location display', () => {
  it('uses a reliable display-only callsign without logbook analysis', () => {
    const location = resolveFrameLocationDisplay(createMessage({
      locationCallsign: 'BG5DRB',
      countryZh: '\u4e2d\u56fd\u00b7\u6d59\u6c5f',
      countryEn: 'China·Zhejiang',
      countryCode: 'CN',
    }), true, false);

    expect(location).toEqual({
      callsign: 'BG5DRB',
      displayName: '\u4e2d\u56fd\u00b7\u6d59\u6c5f',
      text: '\u4e2d\u56fd\u00b7\u6d59\u6c5f',
    });
  });

  it('does not display location fields without a reliable sender callsign', () => {
    const location = resolveFrameLocationDisplay(createMessage({
      countryZh: '\u4e2d\u56fd\u00b7\u6d59\u6c5f',
      countryCode: 'CN',
    }), true, false);

    expect(location).toBeNull();
  });

  it('keeps narrow and translated labels deterministic', () => {
    const message = createMessage({
      locationCallsign: 'BG5DRB',
      countryZh: '\u4e2d\u56fd\u00b7\u6d59\u6c5f',
      countryEn: 'China·Zhejiang',
    });

    expect(resolveFrameLocationDisplay(message, true, true)?.text).toBe('\u6d59\u6c5f');
    expect(resolveFrameLocationDisplay(message, false, false)?.text).toBe('China·Zhejiang');
  });

  it('adds the Grid marker only for a high-confidence location conflict', () => {
    const normal = createMessage({
      locationCallsign: 'JA1ABC',
      countryZh: 'Japan',
      locationGrid: 'PM95',
      gridLocation: {
        grid: 'PM95',
        status: 'compatible',
        countries: [],
      },
    });
    const conflict = createMessage({
      locationCallsign: 'JA1ABC',
      countryZh: 'Japan',
      locationGrid: 'CN87',
      gridLocation: {
        grid: 'CN87',
        status: 'conflict',
        countries: [],
      },
    });

    expect(resolveFrameLocationDisplay(normal, true, false)?.text).toBe('Japan');
    expect(resolveFrameLocationDisplay(conflict, true, false)).toMatchObject({
      text: 'Japan',
      conflictGrid: 'CN87',
    });
  });
});
