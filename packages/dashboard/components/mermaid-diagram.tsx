"use client";

import { AlertCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { getWorkflowMermaid } from "@/lib/workflow-studio/mermaid";

interface MermaidDiagramProps {
  chart: string;
}

const workflowMermaidThemeCss = `
  .node rect,
  .node circle,
  .node ellipse,
  .node polygon,
  .node path {
    stroke-width: 1.5px;
    filter: none;
  }

  .node rect,
  .node polygon,
  .node path {
    rx: 18px;
    ry: 18px;
  }

  .node rect,
  .node polygon {
    fill: rgba(24, 24, 27, 0.92) !important;
    stroke: rgba(63, 63, 70, 0.70) !important;
  }

  .label,
  .nodeLabel,
  .edgeLabel {
    letter-spacing: 0.01em;
  }

  .label text,
  .nodeLabel p,
  .cluster-label text {
    font-weight: 600;
  }

  .nodeLabel,
  .nodeLabel p {
    color: #e4e4e7 !important;
  }

  .edgeLabel,
  .edgeLabel p {
    color: #a1a1aa !important;
    font-weight: 500;
    font-size: 0.75em;
  }

  .cluster rect {
    fill: rgba(24, 24, 27, 0.42);
    stroke: rgba(63, 63, 70, 0.50);
    stroke-width: 1px;
  }

  g.edgeLabel rect,
  .edgeLabel rect {
    fill: rgba(9, 9, 11, 0.92) !important;
    stroke: rgba(63, 63, 70, 0.40) !important;
    rx: 999px;
    ry: 999px;
  }

  .flowchart-link,
  .edgePath .path,
  .edgePath path {
    stroke: rgba(59, 130, 246, 0.35) !important;
    stroke-width: 2px;
  }

  marker path {
    fill: rgba(59, 130, 246, 0.50) !important;
    stroke: none;
  }
`;

const workflowMermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict" as const,
  theme: "base" as const,
  darkMode: true,
  htmlLabels: true,
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  themeVariables: {
    background: "#09090b",
    primaryColor: "#18181b",
    primaryBorderColor: "#3f3f46",
    primaryTextColor: "#e4e4e7",
    secondaryColor: "#18181b",
    secondaryBorderColor: "#3f3f46",
    secondaryTextColor: "#e4e4e7",
    tertiaryColor: "#18181b",
    tertiaryBorderColor: "#3f3f46",
    tertiaryTextColor: "#e4e4e7",
    lineColor: "#3b82f6",
    textColor: "#e4e4e7",
    mainBkg: "#18181b",
    nodeTextColor: "#e4e4e7",
    clusterBkg: "rgba(24, 24, 27, 0.42)",
    clusterBorder: "rgba(63, 63, 70, 0.30)",
    defaultLinkColor: "#3b82f6",
    edgeLabelBackground: "#09090b",
    labelBackground: "#09090b",
    titleColor: "#e4e4e7",
  },
  themeCSS: workflowMermaidThemeCss,
  flowchart: {
    useMaxWidth: true,
    diagramPadding: 24,
    nodeSpacing: 56,
    rankSpacing: 72,
    wrappingWidth: 220,
    curve: "basis" as const,
  },
};

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramId = useId().replace(/:/g, "-");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      if (!chart.trim()) {
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
        }
        setError(null);
        return;
      }

      try {
        const mermaid = await getWorkflowMermaid();
        mermaid.initialize(workflowMermaidConfig);

        const { svg } = await mermaid.render(`workflow-${diagramId}`, chart);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (renderError) {
        if (!cancelled) {
          if (containerRef.current) {
            containerRef.current.innerHTML = "";
          }
          setError(
            renderError instanceof Error
              ? renderError.message
              : "Mermaid rendering failed."
          );
        }
      }
    }

    renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [chart, diagramId]);

  return (
    <div className="relative overflow-hidden rounded-[24px] border border-zinc-800 bg-zinc-950/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-blue-500/5" />
      <div className="absolute -right-12 top-0 h-40 w-40 rounded-full bg-blue-500/5 blur-3xl" />
      <div className="absolute bottom-0 left-6 h-28 w-28 rounded-full bg-blue-500/5 blur-3xl" />
      <div
        className="absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(0,0,0,0.3))",
        }}
      />
      <div className="relative p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-zinc-500">
              Live Diagram
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              Mermaid preview styled to match the GTMShip workspace.
            </p>
          </div>
          <div className="rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-blue-200">
            Auto-rendered
          </div>
        </div>

        {error ? (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-950/60 px-4 py-3 text-sm text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <div>
              <p className="font-medium">Mermaid render failed</p>
              <p className="mt-1 text-xs leading-6 text-amber-200/90">{error}</p>
            </div>
          </div>
        ) : null}
        <div
          ref={containerRef}
          className="relative min-h-[320px] [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        />
      </div>
    </div>
  );
}
