"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { LocalDeploymentDashboard } from "@/components/local-deployment-dashboard";

function LocalDeploymentsFallback() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <section className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-24">
        <div className="inline-flex items-center gap-3 rounded-full border border-zinc-800 bg-zinc-900/70 px-5 py-3 text-sm text-zinc-300">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading local deployments...
        </div>
      </section>
    </main>
  );
}

export default function LocalDeploymentsPage() {
  return (
    <Suspense fallback={<LocalDeploymentsFallback />}>
      <LocalDeploymentDashboard />
    </Suspense>
  );
}
