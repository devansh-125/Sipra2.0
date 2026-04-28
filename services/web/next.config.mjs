/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@deck.gl/core',
    '@deck.gl/layers',
    '@deck.gl/google-maps',
    '@luma.gl/core',
    '@luma.gl/webgl',
  ],
};

export default nextConfig;
