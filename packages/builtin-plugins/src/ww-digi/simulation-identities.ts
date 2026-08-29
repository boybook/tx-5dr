import type { SimulationPeerIdentity } from '@tx5dr/plugin-api';

const REGIONS = [
  ['K1', 'FN31'], ['W2', 'FN20'], ['N3', 'FM19'], ['VE3', 'FN03'],
  ['VA7', 'CN89'], ['XE1', 'EK09'], ['CO2', 'EL83'], ['HI8', 'FK58'],
  ['PY2', 'GG66'], ['LU5', 'GF05'], ['CE3', 'FF46'], ['CX2', 'GF15'],
  ['OA4', 'FH17'], ['YV5', 'FK60'], ['ZP5', 'GG14'], ['G4', 'IO91'],
  ['GM3', 'IO75'], ['EI4', 'IO53'], ['DL1', 'JO62'], ['F4', 'JN18'],
  ['I2', 'JN45'], ['EA3', 'JN11'], ['CT1', 'IM58'], ['PA3', 'JO22'],
  ['ON4', 'JO20'], ['HB9', 'JN47'], ['OE3', 'JN88'], ['OK1', 'JO70'],
  ['SP5', 'KO02'], ['SM6', 'JO57'], ['LA2', 'JO59'], ['OH2', 'KP20'],
  ['OZ1', 'JO55'], ['SV1', 'KM18'], ['LZ2', 'KN33'], ['YO3', 'KN34'],
  ['JA1', 'PM95'], ['JH4', 'PM64'], ['HL2', 'PM37'], ['BY1', 'ON80'],
  ['BG5', 'PL09'], ['BV2', 'PL05'], ['VR2', 'OL72'], ['VU2', 'ML88'],
  ['HS0', 'OK03'], ['9M2', 'OJ03'], ['YB0', 'OI33'], ['DU1', 'PK04'],
  ['VK2', 'QF56'], ['VK6', 'OF87'], ['ZL1', 'RF72'], ['ZS6', 'KG44'],
  ['5R8', 'LH31'], ['CN8', 'IM64'], ['7Q7', 'KH67'], ['D2', 'JI61'],
  ['4X4', 'KM72'], ['A61', 'LL75'], ['A71', 'LL55'], ['UN7', 'MO13'],
  ['UA9', 'NO26'], ['EX8', 'MN72'], ['EY8', 'MM48'], ['AP2', 'MM63'],
] as const;

const SUFFIXES = ['VAA', 'VAB', 'VAC', 'VAD', 'VAE', 'VAF'] as const;

function varyGrid(grid: string, offset: number): string {
  const finalDigit = (Number(grid[3]) + offset) % 10;
  return `${grid.slice(0, 3)}${finalDigit}`;
}

/** Synthetic, globally distributed identities used only by the development simulator. */
export const wwDigiAmbientIdentityPool: SimulationPeerIdentity[] = REGIONS.flatMap(
  ([prefix, grid]) => SUFFIXES.map((suffix, index) => ({
    callsign: `${prefix}${suffix}`,
    grid: varyGrid(grid, index),
  })),
);
