export default function LogsLoading() {
  return (
    <div className="p-6">
      <div className="space-y-4">
        <div className="h-8 w-32 animate-pulse rounded-md bg-zinc-800/60" />
        <div className="h-4 w-48 animate-pulse rounded bg-zinc-800/40" />
        <div className="mt-6 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-6 animate-pulse rounded bg-zinc-900/50"
              style={{ width: `${60 + Math.random() * 35}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
