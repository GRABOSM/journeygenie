/**
 * CRA `PUBLIC_URL` is set for GitHub Pages project sites (e.g. `/journeygenie`).
 * Root-relative `/icon.png` would load from the host root and 404; use this for static assets in `public/`.
 */
export function publicAssetUrl(path) {
  const p = typeof path === 'string' && path.startsWith('/') ? path : `/${path || ''}`;
  const base = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}${p}`;
}
