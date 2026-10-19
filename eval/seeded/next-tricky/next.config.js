/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['sharp'],
    bundlePagesExternals: true,
    useCache: true,
  },
  images: {
    domains: ['cdn.example.com'],
  },
  devIndicators: {
    buildActivity: false,
  },
};

module.exports = nextConfig;
