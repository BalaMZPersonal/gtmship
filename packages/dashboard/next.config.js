const path = require("path");

// Monorepo fix: macOS has a low default file descriptor limit (256) which causes
// EMFILE errors with Next.js native file watchers. Force polling mode.
process.env.WATCHPACK_POLLING = process.env.WATCHPACK_POLLING || "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
  reactStrictMode: true,
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
        ],
      };
    }
    return config;
  },
};

module.exports = nextConfig;
