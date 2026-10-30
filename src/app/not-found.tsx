import Link from "next/link";
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p className="my-4 text-slate-500">
          The page may have moved, or the record is unavailable.
        </p>
        <Link
          className="font-medium text-orange-700 underline"
          href="/dashboard"
        >
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}
