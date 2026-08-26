import type { ImageTemplateTextLayer } from '@tx5dr/contracts';

export type CanvasPoint = { x: number; y: number };

export type TextLayerHandles = {
  center: CanvasPoint;
  scale: CanvasPoint;
  rotate: CanvasPoint;
};

export function textLayerInspectorPlacement(canvasLeftInWindow: number): 'side' | 'bottom' {
  return canvasLeftInWindow >= 232 ? 'side' : 'bottom';
}

const MIN_LAYER_SIZE = 0.03;
const MAX_LAYER_SIZE = 4;
const MIN_FONT_SIZE = 0.02;
const MAX_FONT_SIZE = 1;
const MIN_LAYER_POSITION = -2;
const MAX_LAYER_POSITION = 2;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rotateOffset(offset: CanvasPoint, degrees: number): CanvasPoint {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: offset.x * cosine - offset.y * sine,
    y: offset.x * sine + offset.y * cosine,
  };
}

export function normalizeLayerRotation(degrees: number): number {
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  if (normalized === -180 && degrees > 0) return 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function textLayerHandles(
  layer: ImageTemplateTextLayer,
  canvasWidth: number,
  canvasHeight: number,
  rotateOffsetPixels = 24,
): TextLayerHandles {
  const center = {
    x: (layer.x + layer.width / 2) * canvasWidth,
    y: (layer.y + layer.height / 2) * canvasHeight,
  };
  const rotation = layer.rotation ?? 0;
  const scaleOffset = rotateOffset({ x: layer.width * canvasWidth / 2, y: layer.height * canvasHeight / 2 }, rotation);
  const rotateHandleOffset = rotateOffset({ x: 0, y: -(layer.height * canvasHeight / 2 + rotateOffsetPixels) }, rotation);
  return {
    center,
    scale: { x: center.x + scaleOffset.x, y: center.y + scaleOffset.y },
    rotate: { x: center.x + rotateHandleOffset.x, y: center.y + rotateHandleOffset.y },
  };
}

export function pointDistance(first: CanvasPoint, second: CanvasPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function pointInsideTextLayer(
  point: CanvasPoint,
  layer: ImageTemplateTextLayer,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  const { center } = textLayerHandles(layer, canvasWidth, canvasHeight);
  const local = rotateOffset({ x: point.x - center.x, y: point.y - center.y }, -(layer.rotation ?? 0));
  return Math.abs(local.x) <= layer.width * canvasWidth / 2
    && Math.abs(local.y) <= layer.height * canvasHeight / 2;
}

export function moveTextLayer(
  layer: ImageTemplateTextLayer,
  center: CanvasPoint,
  canvasWidth: number,
  canvasHeight: number,
): ImageTemplateTextLayer {
  const radians = (layer.rotation ?? 0) * Math.PI / 180;
  const halfWidth = layer.width * canvasWidth / 2;
  const halfHeight = layer.height * canvasHeight / 2;
  const extentX = Math.abs(Math.cos(radians)) * halfWidth + Math.abs(Math.sin(radians)) * halfHeight;
  const extentY = Math.abs(Math.sin(radians)) * halfWidth + Math.abs(Math.cos(radians)) * halfHeight;
  const recoveredCenter = {
    x: recoverOffCanvasAxis(center.x, extentX, canvasWidth),
    y: recoverOffCanvasAxis(center.y, extentY, canvasHeight),
  };
  return {
    ...layer,
    x: clamp(recoveredCenter.x / canvasWidth - layer.width / 2, MIN_LAYER_POSITION, MAX_LAYER_POSITION),
    y: clamp(recoveredCenter.y / canvasHeight - layer.height / 2, MIN_LAYER_POSITION, MAX_LAYER_POSITION),
  };
}

function recoverOffCanvasAxis(center: number, extent: number, canvasSize: number): number {
  if (center + extent <= 0) return extent >= canvasSize / 2 ? canvasSize / 2 : extent;
  if (center - extent >= canvasSize) return extent >= canvasSize / 2 ? canvasSize / 2 : canvasSize - extent;
  return center;
}

export function scaleTextLayer(
  layer: ImageTemplateTextLayer,
  requestedScale: number,
  canvasWidth: number,
  canvasHeight: number,
): ImageTemplateTextLayer {
  const minimumScale = Math.max(MIN_LAYER_SIZE / layer.width, MIN_LAYER_SIZE / layer.height, MIN_FONT_SIZE / layer.fontSize);
  const maximumScale = Math.min(MAX_LAYER_SIZE / layer.width, MAX_LAYER_SIZE / layer.height, MAX_FONT_SIZE / layer.fontSize);
  const scale = clamp(requestedScale, minimumScale, maximumScale);
  const { center } = textLayerHandles(layer, canvasWidth, canvasHeight);
  return moveTextLayer({
    ...layer,
    width: layer.width * scale,
    height: layer.height * scale,
    fontSize: layer.fontSize * scale,
  }, center, canvasWidth, canvasHeight);
}

export function resizeTextLayerFont(
  layer: ImageTemplateTextLayer,
  fontSize: number,
  canvasWidth: number,
  canvasHeight: number,
): ImageTemplateTextLayer {
  const boundedFontSize = clamp(fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE);
  const scale = boundedFontSize / layer.fontSize;
  const { center } = textLayerHandles(layer, canvasWidth, canvasHeight);
  return moveTextLayer({
    ...layer,
    width: clamp(layer.width * scale, MIN_LAYER_SIZE, MAX_LAYER_SIZE),
    height: clamp(layer.height * scale, MIN_LAYER_SIZE, MAX_LAYER_SIZE),
    fontSize: boundedFontSize,
  }, center, canvasWidth, canvasHeight);
}

export function rotateTextLayer(
  layer: ImageTemplateTextLayer,
  rotation: number,
  canvasWidth: number,
  canvasHeight: number,
): ImageTemplateTextLayer {
  const { center } = textLayerHandles(layer, canvasWidth, canvasHeight);
  return moveTextLayer({ ...layer, rotation: normalizeLayerRotation(rotation) }, center, canvasWidth, canvasHeight);
}
