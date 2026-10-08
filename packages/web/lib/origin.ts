/*
 * The origin of the absolute links an API answer carries. `next start` builds request.url from its own host and
 * port, so behind Caddy (deploy/docker-compose.yml), where visitors use https://DOMAIN, the request still names
 * http://localhost:3000; the deployment sets SPECFIRST_PUBLIC_ORIGIN to https://DOMAIN instead. Server only.
 */

export const PUBLIC_ORIGIN_ENV = 'SPECFIRST_PUBLIC_ORIGIN';

/** SPECFIRST_PUBLIC_ORIGIN when it is an http(s) URL (its origin only), else the origin of `requestUrl`. */
export function publicOrigin(requestUrl: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[PUBLIC_ORIGIN_ENV]?.trim();
  if (v) {
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
    } catch {
      /* not a URL: use the request's */
    }
  }
  return new URL(requestUrl).origin;
}
