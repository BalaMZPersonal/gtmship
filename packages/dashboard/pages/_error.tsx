import type { NextPageContext } from "next";

type ErrorPageProps = {
  statusCode?: number;
};

export default function ErrorPage({ statusCode }: ErrorPageProps) {
  const title =
    statusCode && statusCode >= 500
      ? "Something went wrong."
      : "This page could not be found.";

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <div className="max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-2xl shadow-black/30">
        <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">
          GTMShip
        </p>
        <h1 className="mt-4 text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm text-zinc-400">
          {statusCode
            ? `HTTP ${statusCode}`
            : "An unexpected dashboard error occurred."}
        </p>
      </div>
    </main>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext): ErrorPageProps => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};
