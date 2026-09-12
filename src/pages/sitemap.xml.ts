// Static sitemap. Fourteen URLs is not worth an integration.
import type { APIRoute } from 'astro';
import { projects } from '../data/content';

const routes = ['/', '/work/', '/research/', '/projects/', '/record/', '/contact/', '/assistant/', ...projects.map((p) => `/projects/${p.slug}/`)];

export const GET: APIRoute = ({ site }) => new Response(
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    routes.map((r) => `  <url><loc>${new URL(r, site)}</loc></url>`).join('\n')
  }\n</urlset>\n`,
  { headers: { 'Content-Type': 'application/xml' } },
);
