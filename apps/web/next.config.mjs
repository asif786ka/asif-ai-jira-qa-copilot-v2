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
    // FastAPI mounts its router at prefix="/pyapi", so the destination must
    // KEEP the /pyapi/ prefix — previously this stripped it and every Python
    // backend call 404'd, surfacing as "Internal Server Error" in the wizard.
    // In Vercel prod, vercel.json handles the rewrite to /api/python.
    if (process.env.NODE_ENV !== "production") {
      return [
        { source: "/pyapi/:path*", destination: "http://localhost:5001/pyapi/:path*" },
      ];
    }
    return [];
  },
};

export default nextConfig;
