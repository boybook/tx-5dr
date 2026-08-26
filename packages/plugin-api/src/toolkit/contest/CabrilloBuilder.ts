export interface CabrilloDocumentInput {
  headers: ReadonlyArray<readonly [label: string, value: string]>;
  qsoLines: readonly string[];
}

/** Deterministic Cabrillo 3.0 document builder with canonical CRLF endings. */
export function buildCabrilloDocument(input: CabrilloDocumentInput): string {
  const lines = [
    'START-OF-LOG: 3.0',
    ...input.headers.map(([label, value]) => `${label}: ${value}`),
    ...input.qsoLines,
    'END-OF-LOG:',
  ];
  return `${lines.join('\r\n')}\r\n`;
}
