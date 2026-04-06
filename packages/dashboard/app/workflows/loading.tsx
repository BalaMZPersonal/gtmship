export default function WorkflowsLoading() {
  return (
    <div className="p-2">
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded-md bg-zinc-800/60" />
        <div className="h-4 w-64 animate-pulse rounded bg-zinc-800/40" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-zinc-800/60 bg-zinc-900/50"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
