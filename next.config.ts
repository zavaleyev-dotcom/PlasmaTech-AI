import type { NextConfig } from 'next';
const config: NextConfig = {
  serverExternalPackages: ['pdf-parse'],
  outputFileTracingIncludes: { '/api/library': ['./scripts/library-pdf-worker.mjs', './node_modules/pdf-parse/**/*', './node_modules/pdfjs-dist/**/*'] },
};
export default config;
