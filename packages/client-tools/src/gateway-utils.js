// Pure HTTP helpers shared by the local web gateway (proxy.js) and the
// remote-station gateway (remote-gateway.js).

export function parseHostHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hostname: '', port: '' };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end !== -1) {
      const hostname = raw.slice(1, end);
      const port = raw.slice(end + 1).replace(/^:/, '');
      return { hostname, port };
    }
  }
  const [hostname, port = ''] = raw.split(':');
  return { hostname, port };
}

export function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

// WHATWG URL replaces the deprecated url.parse() (DEP0169). The fixed origin keeps a
// request target such as `//host/x` a path instead of turning it into an authority.
export function requestPathname(rawUrl) {
  const target = rawUrl || '/';
  return new URL(`http://gateway.invalid${target.startsWith('/') ? '' : '/'}${target}`).pathname;
}
