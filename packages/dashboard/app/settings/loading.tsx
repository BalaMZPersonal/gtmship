export default function SettingsLoading() {
  return (
    <div className="p-6">
      <div className="space-y-4">
        <div className="h-8 w-36 animate-pulse rounded-md bg-zinc-800/60" />
        <div className="mt-6 space-y-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-800/40" />
              <div className="h-10 w-full animate-pulse rounded-lg border border-zinc-800/60 bg-zinc-900/50" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
