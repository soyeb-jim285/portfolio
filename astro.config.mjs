import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://soyebjim.me',
  build: { format: 'directory' },
  redirects: { '/projects/ielts-practice': '/projects/nextband' }, // ponytail: renamed Oct 2026, keep old links working
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
