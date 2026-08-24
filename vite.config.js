import { defineConfig } from 'vite';

// Netlify serves this from the root of a domain; GitHub Pages serves it from
// /<repo>/. Vite has to know which at build time, because it rewrites every
// asset URL -- including the content-hashed league data files -- against it.
//
// BASE_PATH is set only by the Pages workflow, so a plain `npm run build`
// still produces the root-relative bundle Netlify expects.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
});
