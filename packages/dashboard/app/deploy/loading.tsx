export default function DeployLoading() {
  return (
    <div className="p-6">
      <div className="space-y-4">
        <div className="h-8 w-40 animate-pulse rounded-md bg-zinc-800/60" />
        <div className="h-4 w-56 animate-pulse rounded bg-zinc-800/40" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl border border-zinc-800/60 bg-zinc-900/50"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
