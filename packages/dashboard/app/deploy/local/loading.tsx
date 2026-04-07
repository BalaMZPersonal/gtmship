export default function LocalDeploymentsLoading() {
  return (
    <div className="p-6">
      <div className="space-y-4">
        <div className="h-8 w-52 animate-pulse rounded-md bg-zinc-800/60" />
        <div className="h-4 w-72 animate-pulse rounded bg-zinc-800/40" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-48 animate-pulse rounded-2xl border border-zinc-800/60 bg-zinc-900/50"
              />
            ))}
          </div>
          <div className="h-[520px] animate-pulse rounded-2xl border border-zinc-800/60 bg-zinc-900/50" />
        </div>
      </div>
    </div>
  );
}
