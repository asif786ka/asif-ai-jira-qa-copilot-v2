import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card text-center py-20">
      <h2 className="text-2xl font-semibold mb-2">404</h2>
      <p className="text-sm text-gray-400 mb-4">That page doesn't exist.</p>
      <Link href="/" className="btn-primary inline-flex">
        Back to home
      </Link>
    </div>
  );
}
