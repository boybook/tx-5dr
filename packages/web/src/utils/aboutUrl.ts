export function getAboutPageUrl(options: { embed?: boolean } = {}): string {
  const baseHref = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
  const url = new URL('about.html', baseHref);

  if (options.embed) {
    url.searchParams.set('embed', '1');
  }

  return url.href;
}
