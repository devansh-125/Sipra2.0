/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@deck.gl/core',
    '@deck.gl/layers',
    '@deck.gl/google-maps',
    '@luma.gl/core',
    '@luma.gl/webgl',
  ],
};

export default nextConfig;
