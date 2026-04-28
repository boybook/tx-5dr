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

function tryGetUrlOrigin(value: string | undefined): { protocol: string; host: string } | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return {
      protocol: url.protocol.replace(/:$/, '') || 'http',
      host: url.host,
    };
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

function getHostnameFromHost(host: string | null): string | null {
  if (!host) {
    return null;
  }

  const trimmed = host.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  const firstColon = trimmed.indexOf(':');
  const lastColon = trimmed.lastIndexOf(':');
  if (firstColon !== -1 && firstColon === lastColon) {
    return trimmed.slice(0, firstColon);
  }
  return trimmed;
}

function isLoopbackHostname(hostname: string | null): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '0.0.0.0'
    || Boolean(hostname?.startsWith('127.'));
}

function shouldUseBrowserOrigin(browserHost: string, proxyHost: string | null): boolean {
  const browserHostname = getHostnameFromHost(browserHost);
  const proxyHostname = getHostnameFromHost(proxyHost);
  return !proxyHostname
    || browserHostname === proxyHostname
    || isLoopbackHostname(proxyHostname);
}

export function resolveBrowserFacingRequestOrigin(options: RequestOriginOptions): {
  protocol: string;
  host: string;
} {
  const headers = options.headers ?? {};
  const forwardedProtocol = getHeaderValue(headers['x-forwarded-proto'])?.split(',')[0]?.trim();
  const protocol = forwardedProtocol || options.requestProtocol || 'http';
  const forwardedHost = getHeaderValue(headers['x-forwarded-host'])?.split(',')[0]?.trim() || null;
  const hostHeader = getHeaderValue(headers.host)?.split(',')[0]?.trim() || null;
  const forwardedPort = getHeaderValue(headers['x-forwarded-port'])?.split(',')[0]?.trim() || null;
  const originHeader = getHeaderValue(headers.origin)?.split(',')[0]?.trim();
  const refererHeader = getHeaderValue(headers.referer)?.split(',')[0]?.trim();
  const browserOrigin = tryGetUrlOrigin(originHeader) || tryGetUrlOrigin(refererHeader);
  const proxyHost = forwardedHost || hostHeader;
  const useBrowserOrigin = Boolean(browserOrigin && shouldUseBrowserOrigin(browserOrigin.host, proxyHost));
  const originHost = useBrowserOrigin ? browserOrigin!.host : tryGetUrlHost(originHeader);
  const refererHost = browserOrigin ? null : tryGetUrlHost(refererHeader);

  if (browserOrigin && useBrowserOrigin) {
    return {
      protocol: browserOrigin.protocol,
      host: browserOrigin.host,
    };
  }

  const host = appendPort(
    forwardedHost || hostHeader || originHost || refererHost || options.fallbackHost,
    forwardedPort,
  );

  return {
    protocol,
    host,
  };
}
