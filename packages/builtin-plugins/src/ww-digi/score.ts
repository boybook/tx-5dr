export const WW_DIGI_SCORE_BANDS = ['160M', '80M', '40M', '20M', '15M', '10M'] as const;

export interface WWDigiScoreRecord {
  qsoId: string;
  callsign: string;
  sentGrid: string;
  receivedGrid?: string;
  band: string;
  startTime: number;
  status: 'included' | 'x-qso' | 'review';
}

export interface WWDigiScoreRow<T extends WWDigiScoreRecord = WWDigiScoreRecord> {
  record: T;
  dupe: boolean;
  gridField?: string;
  qsoPoints: number | null;
  creditedPoints: number;
  newMultiplier: boolean;
  countsForScore: boolean;
}

export interface WWDigiBandScore {
  band: string;
  qsos: number;
  qsoPoints: number;
  gridFields: number;
}

export interface WWDigiScoreSummary<T extends WWDigiScoreRecord = WWDigiScoreRecord> {
  rows: WWDigiScoreRow<T>[];
  bands: WWDigiBandScore[];
  scoredQsos: number;
  qsoPoints: number;
  gridFields: number;
  claimedScore: number;
  reviewCount: number;
}

function validGrid(grid: string | undefined): string | undefined {
  const normalized = grid?.trim().toUpperCase().slice(0, 4);
  return normalized && /^[A-R]{2}\d{2}$/.test(normalized) ? normalized : undefined;
}

export function calculateWWDigiQsoPoints(sentGrid: string, receivedGrid: string): number | null {
  const sent = validGrid(sentGrid);
  const received = validGrid(receivedGrid);
  if (!sent || !received) return null;
  const distanceKm = calculateWWDigiGridDistance(sent, received);
  return distanceKm === null ? null : 1 + Math.floor(distanceKm / 3_000);
}

export function calculateWWDigiGridDistance(sentGrid: string, receivedGrid: string): number | null {
  const sent = validGrid(sentGrid);
  const received = validGrid(receivedGrid);
  if (!sent || !received) return null;
  const center = (grid: string) => ({
    lon: (grid.charCodeAt(0) - 65) * 20 - 180 + Number(grid[2]) * 2 + 1,
    lat: (grid.charCodeAt(1) - 65) * 10 - 90 + Number(grid[3]) + 0.5,
  });
  const from = center(sent);
  const to = center(received);
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.lat - from.lat);
  const longitudeDelta = radians(to.lon - from.lon);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function summarizeWWDigiScore<T extends WWDigiScoreRecord>(
  records: readonly T[],
  categoryBand = 'ALL',
): WWDigiScoreSummary<T> {
  const worked = new Set<string>();
  const fieldsByBand = new Map<string, Set<string>>();
  const bandTotals = new Map<string, WWDigiBandScore>(
    WW_DIGI_SCORE_BANDS.map((band) => [band, { band, qsos: 0, qsoPoints: 0, gridFields: 0 }]),
  );
  let reviewCount = 0;
  const rows = [...records]
    .sort((left, right) => left.startTime - right.startTime || left.qsoId.localeCompare(right.qsoId))
    .map((record): WWDigiScoreRow<T> => {
      const callsign = record.callsign.trim().toUpperCase();
      const band = record.band.trim().toUpperCase();
      const workedKey = `${callsign}:${band}`;
      const countsAsWorked = record.status === 'included' || record.status === 'review';
      const dupe = countsAsWorked && worked.has(workedKey);
      if (countsAsWorked) worked.add(workedKey);

      const receivedGrid = validGrid(record.receivedGrid);
      const gridField = receivedGrid?.slice(0, 2);
      const qsoPoints = calculateWWDigiQsoPoints(record.sentGrid, record.receivedGrid ?? '');
      const countsForScore = countsAsWorked && !dupe && qsoPoints !== null && gridField !== undefined;
      const fields = fieldsByBand.get(band) ?? new Set<string>();
      const newMultiplier = countsForScore && !fields.has(gridField!);
      if (countsForScore) {
        fields.add(gridField!);
        fieldsByBand.set(band, fields);
        const totals = bandTotals.get(band) ?? { band, qsos: 0, qsoPoints: 0, gridFields: 0 };
        totals.qsos += 1;
        totals.qsoPoints += qsoPoints;
        totals.gridFields = fields.size;
        bandTotals.set(band, totals);
      }
      if (record.status === 'review' || (countsAsWorked && qsoPoints === null)) reviewCount += 1;
      return {
        record,
        dupe,
        gridField,
        qsoPoints,
        creditedPoints: countsForScore ? qsoPoints : 0,
        newMultiplier,
        countsForScore,
      };
    });

  const selectedBands = categoryBand === 'ALL'
    ? new Set(WW_DIGI_SCORE_BANDS)
    : new Set([categoryBand.toUpperCase()]);
  const bands = WW_DIGI_SCORE_BANDS.map((band) => bandTotals.get(band)!);
  const entryBands = bands.filter((band) => selectedBands.has(band.band));
  const qsoPoints = entryBands.reduce((sum, band) => sum + band.qsoPoints, 0);
  const gridFields = entryBands.reduce((sum, band) => sum + band.gridFields, 0);
  return {
    rows,
    bands,
    scoredQsos: entryBands.reduce((sum, band) => sum + band.qsos, 0),
    qsoPoints,
    gridFields,
    claimedScore: qsoPoints * gridFields,
    reviewCount,
  };
}
