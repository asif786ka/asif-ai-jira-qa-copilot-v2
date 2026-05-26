/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@jiraqa/core", "@jiraqa/providers"],
  experimental: {
    serverActions: {
      // Up to 3 screenshots × 5MB each, plus prompt overhead — 20mb is a safe ceiling.
      bodySizeLimit: "20mb",
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
