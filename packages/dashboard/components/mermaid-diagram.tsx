"use client";

import { AlertCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

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
    filter: drop-shadow(0 10px 24px rgba(15, 23, 42, 0.22));
  }

  .node rect,
  .node polygon,
  .node path {
    rx: 18px;
    ry: 18px;
  }

  .node.default rect,
  .node.default polygon,
  .node.default path {
    fill: rgba(15, 23, 42, 0.92);
  }

  .label,
  .nodeLabel,
  .edgeLabel {
    letter-spacing: 0.01em;
  }

  .label text,
  .nodeLabel p,
  .edgeLabel p,
  .cluster-label text {
    font-weight: 600;
  }

  .cluster rect {
    fill: rgba(15, 23, 42, 0.42);
    stroke: rgba(125, 211, 252, 0.22);
    stroke-width: 1px;
  }

  g.edgeLabel rect,
  .edgeLabel rect {
    fill: rgba(9, 14, 28, 0.92) !important;
    stroke: rgba(59, 130, 246, 0.32) !important;
    rx: 999px;
    ry: 999px;
  }

  .flowchart-link,
  .edgePath .path,
  .edgePath path {
    stroke-width: 2px;
  }

  marker path {
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
    primaryColor: "#0f172a",
    primaryBorderColor: "#3b82f6",
    primaryTextColor: "#f8fafc",
    secondaryColor: "#082f49",
    secondaryBorderColor: "#38bdf8",
    secondaryTextColor: "#e0f2fe",
    tertiaryColor: "#18181b",
    tertiaryBorderColor: "#3f3f46",
    tertiaryTextColor: "#e4e4e7",
    lineColor: "#38bdf8",
    textColor: "#e4e4e7",
    mainBkg: "#0f172a",
    nodeTextColor: "#f8fafc",
    clusterBkg: "rgba(15, 23, 42, 0.42)",
    clusterBorder: "rgba(125, 211, 252, 0.22)",
    defaultLinkColor: "#38bdf8",
    edgeLabelBackground: "#090e1c",
    labelBackground: "#090e1c",
    titleColor: "#f8fafc",
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
        const mermaid = (await import("mermaid")).default;
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
    <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-zinc-950/65 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/8 via-transparent to-cyan-500/10" />
      <div className="absolute -right-12 top-0 h-40 w-40 rounded-full bg-blue-500/10 blur-3xl" />
      <div className="absolute bottom-0 left-6 h-28 w-28 rounded-full bg-cyan-500/10 blur-3xl" />
      <div
        className="absolute inset-0 opacity-40"
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
