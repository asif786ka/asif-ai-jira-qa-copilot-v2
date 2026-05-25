/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@jiraqa/core", "@jiraqa/providers"],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  async rewrites() {
    // For local dev so /pyapi/* hits the FastAPI sidecar on :5001.
    // In Vercel prod, vercel.json handles the rewrite to /api/py/*.
    if (process.env.NODE_ENV !== "production") {
      return [
        { source: "/pyapi/:path*", destination: "http://localhost:5001/:path*" },
      ];
    }
    return [];
  },
};

export default nextConfig;
