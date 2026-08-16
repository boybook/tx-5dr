import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeIpAddress(value: string): string {
  return value.trim().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
}

export function isLoopbackAddress(value: string): boolean {
  const normalized = normalizeIpAddress(value).toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isIpLiteralHostname(value: string): boolean {
  return isIP(normalizeIpAddress(value)) !== 0;
}

/** Only accept proxy-supplied client addresses from a local reverse proxy. */
export function getTrustedClientIp(request: Pick<FastifyRequest, 'headers' | 'raw'>): string {
  const direct = normalizeIpAddress(request.raw.socket.remoteAddress || 'unknown');
  if (!isLoopbackAddress(direct)) return direct;

  const realIp = normalizeIpAddress(firstHeaderValue(request.headers['x-real-ip']) || '');
  if (isIP(realIp) !== 0) return realIp;

  const forwarded = firstHeaderValue(request.headers['x-forwarded-for']);
  const lastForwarded = forwarded?.split(',').map(normalizeIpAddress).filter(Boolean).at(-1);
  return lastForwarded && isIP(lastForwarded) !== 0 ? lastForwarded : direct;
}
