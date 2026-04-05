"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import {
  formatSetupProgress,
  getNextSetupStep,
  type SetupStatusResponse,
} from "@/lib/setup";

interface SetupPromptProps {
  className?: string;
}

export function SetupPrompt({ className = "" }: SetupPromptProps) {
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    let active = true;

    api
      .getSetupStatus()
      .then((response) => {
        if (active) {
          setStatus(response);
        }
      })
      .catch(() => {
        if (active) {
          setStatus(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const nextStep = useMemo(
    () => (status ? getNextSetupStep(status.steps) : null),
    [status]
  );

  if (!status || status.dismissed || status.overallStatus === "complete") {
    return null;
  }

  return (
    <section
      className={`rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-500/10 via-zinc-900 to-zinc-950 p-5 ${className}`}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-blue-200">
            <Sparkles size={12} />
            Optional setup
          </div>
          <h2 className="mt-3 text-lg font-semibold text-white">
            Finish the basics for AI, cloud, and secrets
          </h2>
          <p className="mt-2 text-sm leading-6 text-zinc-300">
            {formatSetupProgress(status.progress)}
            {nextStep ? ` • Next up: ${nextStep.title}.` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/setup"
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Continue setup
            <ArrowRight size={14} />
          </Link>

          <button
            type="button"
            disabled={dismissing}
            onClick={async () => {
              setDismissing(true);
              try {
                const response = await api.updateSetupState({ dismissed: true });
                setStatus(response);
              } finally {
                setDismissing(false);
              }
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {dismissing ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
