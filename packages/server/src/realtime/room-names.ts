export function buildRadioRoomName(activeProfileId: string | null | undefined): string {
  return `radio:${activeProfileId || 'default'}`;
}

export function buildOpenWebRXPreviewRoomName(previewSessionId: string): string {
  return `openwebrx-preview:${previewSessionId}`;
}
