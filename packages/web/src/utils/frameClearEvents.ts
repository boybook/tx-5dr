export const CLEAR_MY_RELATED_FRAMES_EVENT = 'tx5dr:clear-my-related-frames';

export function clearMyRelatedFrames(): void {
  window.dispatchEvent(new Event(CLEAR_MY_RELATED_FRAMES_EVENT));
}
