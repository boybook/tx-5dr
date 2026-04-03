interface RequestOriginOptions {
  headers?: Record<string, string | string[] | undefined>;
  requestProtocol?: string;
  fallbackHost: string;
}

export function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function hostIncludesExplicitPort(host: string): boolean {
  if (host.startsWith('[')) {
    return /\]:\d+$/.test(host);
  }

  const firstColon = host.indexOf(':');
  const lastColon = host.lastIndexOf(':');
  return firstColon !== -1 && firstColon === lastColon;
}

function tryGetUrlHost(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function appendPort(host: string, port: string | null): string {
  if (!port || !port.trim() || hostIncludesExplicitPort(host)) {
    return host;
  }

  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]:${port}`;
  }

  return `${host}:${port}`;
}

export function resolveBrowserFacingRequestOrigin(options: RequestOriginOptions): {
  protocol: string;
  host: string;
} {
  const headers = options.headers ?? {};
  const protocol = getHeaderValue(headers['x-forwarded-proto'])?.split(',')[0]?.trim()
    || options.requestProtocol
    || 'http';
  const forwardedHost = getHeaderValue(headers['x-forwarded-host'])?.split(',')[0]?.trim() || null;
  const hostHeader = getHeaderValue(headers.host)?.split(',')[0]?.trim() || null;
  const forwardedPort = getHeaderValue(headers['x-forwarded-port'])?.split(',')[0]?.trim() || null;
  const originHost = tryGetUrlHost(getHeaderValue(headers.origin)?.split(',')[0]?.trim());
  const refererHost = tryGetUrlHost(getHeaderValue(headers.referer)?.split(',')[0]?.trim());

  const host = appendPort(
    forwardedHost || originHost || refererHost || hostHeader || options.fallbackHost,
    forwardedPort,
  );

  return {
    protocol,
    host,
  };
}
