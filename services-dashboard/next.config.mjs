/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for Docker multi-stage build: copies only the minimal runtime
  // files into the final image. The Dockerfile copies .next/standalone + static.
  output: "standalone",
};

export default nextConfig;
