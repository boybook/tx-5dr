export function normalizeDigitalMessageText(message: string): string {
  return message.trim().toUpperCase().replace(/\s+/g, ' ');
}

export function digitalMessageTextsMatch(requested: string, transmitted: string | undefined): boolean {
  return normalizeDigitalMessageText(requested) === normalizeDigitalMessageText(transmitted ?? '');
}
