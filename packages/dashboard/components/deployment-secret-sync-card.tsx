import type { WorkflowSecretSyncSummary } from "@/lib/deploy";
import { formatDisplayValue } from "@/lib/display-value";
import { cn } from "@/lib/utils";

interface DeploymentSecretSyncCardProps {
  summary: WorkflowSecretSyncSummary;
  title?: string;
  description?: string;
  className?: string;
  emptyState?: string;
  maxEntries?: number;
  showWorkflowLabel?: boolean;
}

export function DeploymentSecretSyncCard({
  summary,
  title = "Secret Sync",
  description,
  className,
  emptyState = "No connection secrets resolved yet.",
  maxEntries,
  showWorkflowLabel = false,
}: DeploymentSecretSyncCardProps) {
  const visibleEntries =
    typeof maxEntries === "number"
      ? summary.entries.slice(0, maxEntries)
      : summary.entries;
  const hiddenCount = summary.entries.length - visibleEntries.length;
  const secretLabel = summary.secretCount === 1 ? "secret" : "secrets";

  return (
    <div
      className={cn(
        "rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-3",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            {title}
          </p>
          {description ? (
            <p className="mt-1 text-xs text-zinc-500">{description}</p>
          ) : null}
        </div>
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300">
          {summary.secretCount} {secretLabel}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-zinc-400 md:grid-cols-2">
        <p>
          <span className="text-zinc-500">Backend:</span>{" "}
          {formatDisplayValue(summary.backendKind) || "Pending backend selection"}
        </p>
        <p>
          <span className="text-zinc-500">Target:</span>{" "}
          {formatDisplayValue(summary.backendTarget) || "Pending backend target"}
        </p>
        <p>
          <span className="text-zinc-500">Secret prefix:</span>{" "}
          {formatDisplayValue(summary.secretPrefix) || "gtmship-connections"}
        </p>
        <p>
          <span className="text-zinc-500">Runtime access:</span>{" "}
          {formatDisplayValue(summary.runtimeAccess) || "direct"}
        </p>
      </div>

      {visibleEntries.length > 0 ? (
        <div className="mt-3 space-y-2">
          {visibleEntries.map((entry) => (
            <div
              key={entry.key}
              className="rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-300"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-zinc-200">{entry.providerSlug}</p>
                {showWorkflowLabel ? (
                  <span className="text-[11px] text-zinc-500">
                    {entry.workflowTitle}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-zinc-500">
                Connection:{" "}
                <span className="text-zinc-300">{entry.connectionId}</span>
              </p>
              <p className="mt-1 break-all text-zinc-500">
                Secret ref:{" "}
                <span className="text-zinc-300">{entry.secretRef}</span>
              </p>
            </div>
          ))}

          {hiddenCount > 0 ? (
            <p className="text-xs text-zinc-500">
              {hiddenCount} more secret sync target
              {hiddenCount === 1 ? "" : "s"} hidden from this summary.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">{emptyState}</p>
      )}
    </div>
  );
}
