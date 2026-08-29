export type WWDigiMessage =
  | { type: 'cq'; senderCallsign: string; grid: string }
  | { type: 'grid'; targetCallsign: string; senderCallsign: string; grid: string }
  | { type: 'roger-grid'; targetCallsign: string; senderCallsign: string; grid: string }
  | { type: 'rr73'; targetCallsign: string; senderCallsign: string }
  | { type: 'unknown' };

const CALLSIGN = /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/;
const GRID = /^[A-R]{2}[0-9]{2}$/;

function normalizedTokens(raw: string): string[] {
  return raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
}

export function parseWWDigiMessage(raw: string): WWDigiMessage {
  const parts = normalizedTokens(raw);
  if (parts.length === 4 && parts[0] === 'CQ' && parts[1] === 'WW'
      && CALLSIGN.test(parts[2]!) && GRID.test(parts[3]!)) {
    return { type: 'cq', senderCallsign: parts[2]!, grid: parts[3]! };
  }
  // RR73 is also shaped like a valid four-character grid, so reserved
  // protocol tokens must be recognized before the generic grid exchange.
  if (parts.length === 3 && CALLSIGN.test(parts[0]!) && CALLSIGN.test(parts[1]!)
      && parts[2] === 'RR73') {
    return { type: 'rr73', targetCallsign: parts[0]!, senderCallsign: parts[1]! };
  }
  if (parts.length === 3 && CALLSIGN.test(parts[0]!) && CALLSIGN.test(parts[1]!)
      && GRID.test(parts[2]!)) {
    return { type: 'grid', targetCallsign: parts[0]!, senderCallsign: parts[1]!, grid: parts[2]! };
  }
  if (parts.length === 4 && CALLSIGN.test(parts[0]!) && CALLSIGN.test(parts[1]!)
      && parts[2] === 'R' && GRID.test(parts[3]!)) {
    return { type: 'roger-grid', targetCallsign: parts[0]!, senderCallsign: parts[1]!, grid: parts[3]! };
  }
  return { type: 'unknown' };
}

export function buildWWDigiCQ(callsign: string, grid: string): string {
  return `CQ WW ${callsign.trim().toUpperCase()} ${grid.trim().toUpperCase().slice(0, 4)}`;
}

export function buildWWDigiGrid(targetCallsign: string, myCallsign: string, myGrid: string): string {
  return `${targetCallsign.trim().toUpperCase()} ${myCallsign.trim().toUpperCase()} ${myGrid.trim().toUpperCase().slice(0, 4)}`;
}

export function buildWWDigiRogerGrid(targetCallsign: string, myCallsign: string, myGrid: string): string {
  return `${targetCallsign.trim().toUpperCase()} ${myCallsign.trim().toUpperCase()} R ${myGrid.trim().toUpperCase().slice(0, 4)}`;
}

export function buildWWDigiRR73(targetCallsign: string, myCallsign: string): string {
  return `${targetCallsign.trim().toUpperCase()} ${myCallsign.trim().toUpperCase()} RR73`;
}

export function buildWWDigi73(targetCallsign: string, myCallsign: string): string {
  return `${targetCallsign.trim().toUpperCase()} ${myCallsign.trim().toUpperCase()} 73`;
}

export function isFourCharacterGrid(value: string | undefined): value is string {
  return Boolean(value && GRID.test(value.trim().toUpperCase()));
}
