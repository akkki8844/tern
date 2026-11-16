/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // These packages are Node-only and must not be bundled by the Next server compiler.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "pino", "pino-pretty", "octokit", "@octokit/auth-app"]
};

export default nextConfig;
