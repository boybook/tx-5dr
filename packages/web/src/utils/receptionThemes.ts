/**
 * Colour themes of the reception layer on the logbook globe.
 *
 * The glow is rendered additively over the night texture, so each ramp fades
 * to nothing at sparse edges and its alpha scales the light it adds.
 */

export type ReceptionThemeId = 'teal' | 'spectrum' | 'aurora' | 'ember';

export interface ReceptionTheme {
  id: ReceptionThemeId;
  /** i18n key (logbook namespace) of the theme name. */
  labelKey: string;
  /** CSS background of the round swatch and of the status dot. */
  swatch: string;
  /** `r, g, b` of receiver points, chosen to stand out on the theme's glow. */
  pointRgb: string;
  /** `r, g, b` of ring tails and the control accent. */
  accentRgb: string;
  /** Glow colour for a normalised density 0..1. */
  fogColor: (density: number) => string;
}

type Rgb = [number, number, number];

const FOG_THRESHOLD = 0.035;

function createFogRamp(stops: Array<[number, Rgb]>, baseAlpha: number, alphaRange: number, gamma: number) {
  const transparent = `rgba(${stops[0][1].join(', ')}, 0)`;
  return (density: number): string => {
    if (density < FOG_THRESHOLD) return transparent;
    const k = Math.min(1, (density - FOG_THRESHOLD) / (1 - FOG_THRESHOLD));
    let upper = stops.findIndex(([position]) => position >= k);
    if (upper <= 0) upper = Math.max(1, upper);
    const [startPosition, start] = stops[upper - 1];
    const [endPosition, end] = stops[upper];
    const t = endPosition > startPosition ? (k - startPosition) / (endPosition - startPosition) : 0;
    const channel = (index: number) => Math.round(start[index] + (end[index] - start[index]) * t);
    const alpha = baseAlpha + Math.pow(k, gamma) * alphaRange;
    return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha.toFixed(3)})`;
  };
}

export const RECEPTION_THEMES: readonly ReceptionTheme[] = [
  {
    id: 'teal',
    labelKey: 'globe.receptionThemeTeal',
    swatch: 'radial-gradient(circle at 35% 35%, rgb(167, 243, 208), rgb(45, 212, 191) 55%, rgb(15, 118, 110))',
    pointRgb: '94, 234, 212',
    accentRgb: '45, 212, 191',
    fogColor: createFogRamp([[0, [20, 150, 140]], [1, [94, 234, 212]]], 0.05, 0.35, 0.7),
  },
  {
    id: 'spectrum',
    labelKey: 'globe.receptionThemeSpectrum',
    swatch: 'conic-gradient(from 200deg, rgb(37, 99, 235), rgb(34, 211, 238), rgb(74, 222, 128), rgb(250, 204, 21), rgb(239, 68, 68), rgb(37, 99, 235))',
    pointRgb: '248, 250, 252',
    accentRgb: '74, 222, 128',
    fogColor: createFogRamp([
      [0, [37, 99, 235]],
      [0.25, [34, 211, 238]],
      [0.5, [74, 222, 128]],
      [0.75, [250, 204, 21]],
      [1, [239, 68, 68]],
    ], 0.08, 0.42, 0.6),
  },
  {
    id: 'aurora',
    labelKey: 'globe.receptionThemeAurora',
    swatch: 'linear-gradient(135deg, rgb(139, 92, 246), rgb(45, 212, 191) 55%, rgb(190, 242, 100))',
    pointRgb: '233, 213, 255',
    accentRgb: '167, 139, 250',
    fogColor: createFogRamp([[0, [109, 40, 217]], [0.5, [45, 212, 191]], [1, [190, 242, 100]]], 0.06, 0.38, 0.65),
  },
  {
    id: 'ember',
    labelKey: 'globe.receptionThemeEmber',
    swatch: 'radial-gradient(circle at 35% 35%, rgb(253, 224, 71), rgb(234, 88, 12) 55%, rgb(127, 29, 29))',
    pointRgb: '254, 215, 170',
    accentRgb: '251, 146, 60',
    fogColor: createFogRamp([[0, [127, 29, 29]], [0.5, [234, 88, 12]], [1, [253, 224, 71]]], 0.06, 0.38, 0.65),
  },
];

export const DEFAULT_RECEPTION_THEME = RECEPTION_THEMES[0];

export function getReceptionTheme(id: string | null | undefined): ReceptionTheme {
  return RECEPTION_THEMES.find(theme => theme.id === id) ?? DEFAULT_RECEPTION_THEME;
}

const RECEPTION_THEME_STORAGE_KEY = 'tx5dr.logbookGlobe.receptionTheme';

export function loadReceptionThemeId(): ReceptionThemeId {
  try {
    return getReceptionTheme(window.localStorage.getItem(RECEPTION_THEME_STORAGE_KEY)).id;
  } catch {
    return DEFAULT_RECEPTION_THEME.id;
  }
}

export function saveReceptionThemeId(id: ReceptionThemeId): void {
  try {
    window.localStorage.setItem(RECEPTION_THEME_STORAGE_KEY, id);
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for the page.
  }
}
