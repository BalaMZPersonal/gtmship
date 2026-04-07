"use client";

import { useEffect, useMemo, useState } from "react";
import { BellRing, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { api, type UpdateStatusResponse } from "@/lib/api";

function shouldShowBanner(status: UpdateStatusResponse | null): status is UpdateStatusResponse {
  if (!status) {
    return false;
  }

  if (status.snoozedUntil && Date.parse(status.snoozedUntil) > Date.now()) {
    return false;
  }

  return status.updateAvailable || status.restartRequired;
}

function bannerClasses(status: UpdateStatusResponse): string {
  if (status.restartRequired) {
    return "border-amber-400/40 bg-amber-500/10 text-amber-50";
  }

  if (status.severity === "critical") {
    return "border-rose-400/40 bg-rose-500/10 text-rose-50";
  }

  if (status.severity === "warning") {
    return "border-amber-400/40 bg-amber-500/10 text-amber-50";
  }

  return "border-cyan-400/40 bg-cyan-500/10 text-cyan-50";
}

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const nextStatus = await api.getUpdateStatus();
        if (!cancelled) {
          setStatus(nextStatus);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const command = useMemo(() => {
    if (!status) {
      return "";
    }

    return status.recommendedCommand || (status.restartRequired ? "gtmship restart" : "");
  }, [status]);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  if (loading) {
    return null;
  }

  if (!shouldShowBanner(status)) {
    return null;
  }

  async function handleCopy() {
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleSnooze() {
    if (!status?.latestVersion) {
      return;
    }

    setSaving(true);
    try {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const nextStatus = await api.snoozeUpdateNotice(status.latestVersion, tomorrow);
      setStatus(nextStatus);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`border-b px-5 py-3 ${bannerClasses(status)}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 rounded-full border border-current/20 p-2">
            {status.restartRequired ? <RefreshCw size={15} /> : <BellRing size={15} />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {status.restartRequired
                ? "Restart GTMShip to load the installed update"
                : "A newer GTMShip release is available"}
            </p>
            {status.message ? (
              <p className="mt-1 text-sm text-current/85">{status.message}</p>
            ) : null}
            {command ? (
              <p className="mt-2 font-mono text-xs text-current/75">{command}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {command ? (
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-2 rounded-md border border-current/20 px-3 py-1.5 text-xs font-medium text-current transition hover:bg-white/5"
            >
              <Copy size={14} />
              {copied ? "Copied" : "Copy Command"}
            </button>
          ) : null}

          {status.notesUrl ? (
            <a
              href={status.notesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-current/20 px-3 py-1.5 text-xs font-medium text-current transition hover:bg-white/5"
            >
              <ExternalLink size={14} />
              Release Notes
            </a>
          ) : null}

          <button
            type="button"
            onClick={() => void handleSnooze()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md border border-current/20 px-3 py-1.5 text-xs font-medium text-current transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Remind Me Tomorrow
          </button>
        </div>
      </div>
    </div>
  );
}
