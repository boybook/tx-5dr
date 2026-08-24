import type { ImagePaperBoundary } from '@tx5dr/contracts';

export interface PaperSectionLayoutInput<T> {
  boundary: ImagePaperBoundary;
  displayWidth: number;
  chunks: Array<{ startLine: number; endLine: number }>;
  data: T;
}

export type PaperLayoutItem<T> =
  | { key: string; kind: 'divider'; top: number; height: number; boundary: ImagePaperBoundary; data: T }
  | { key: string; kind: 'chunk'; top: number; height: number; startLine: number; endLine: number; data: T };

export function buildPaperLayout<T>(
  sections: PaperSectionLayoutInput<T>[],
  viewportWidth: number,
  dividerHeight: (boundary: ImagePaperBoundary) => number,
): { items: PaperLayoutItem<T>[]; height: number } {
  const items: PaperLayoutItem<T>[] = [];
  let top = 0;
  for (const section of sections) {
    const height = dividerHeight(section.boundary);
    if (height > 0) {
      items.push({ key: `divider:${section.boundary.boundaryId}`, kind: 'divider', top, height, boundary: section.boundary, data: section.data });
      top += height;
    }
    const scale = Math.max(1, viewportWidth) / section.displayWidth;
    for (const chunk of section.chunks) {
      const chunkHeight = Math.max(1, (chunk.endLine - chunk.startLine) * scale);
      items.push({ key: `chunk:${section.boundary.boundaryId}:${chunk.startLine}`, kind: 'chunk', top, height: chunkHeight, startLine: chunk.startLine, endLine: chunk.endLine, data: section.data });
      top += chunkHeight;
    }
  }
  return { items, height: top };
}

export function visiblePaperItems<T>(
  items: PaperLayoutItem<T>[],
  paperOffset: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = viewportHeight,
): PaperLayoutItem<T>[] {
  return items.filter((item) => {
    const top = paperOffset + item.top;
    return top + item.height >= scrollTop - overscan
      && top <= scrollTop + viewportHeight + overscan;
  });
}

export function paperBottomTarget(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}
