import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // deck.gl ships ESM-only sub-packages; transpile them so Next.js can bundle them.
  transpilePackages: [
    '@deck.gl/core',
    '@deck.gl/layers',
    '@deck.gl/google-maps',
    '@luma.gl/core',
    '@luma.gl/webgl',
  ],
};

export default nextConfig;
