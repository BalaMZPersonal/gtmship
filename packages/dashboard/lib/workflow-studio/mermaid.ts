import mermaid, { type ExternalDiagramDefinition, type Mermaid } from "mermaid";
import { diagram as flowchartDiagram } from "mermaid/dist/chunks/mermaid.core/flowDiagram-DWJPFMVM.mjs";

const graphPattern = /^\s*graph/;
const flowchartPattern = /^\s*flowchart/;

const flowchartDetectors: ExternalDiagramDefinition[] = [
  {
    id: "flowchart-v2",
    detector: (text, config) => {
      if (config?.flowchart?.defaultRenderer === "dagre-d3") {
        return false;
      }
      if (config?.flowchart?.defaultRenderer === "elk") {
        config.layout = "elk";
      }
      if (
        graphPattern.test(text) &&
        config?.flowchart?.defaultRenderer === "dagre-wrapper"
      ) {
        return true;
      }
      return flowchartPattern.test(text);
    },
    loader: async () => ({
      id: "flowchart-v2",
      diagram: flowchartDiagram,
    }),
  },
  {
    id: "flowchart",
    detector: (text, config) => {
      if (
        config?.flowchart?.defaultRenderer === "dagre-wrapper" ||
        config?.flowchart?.defaultRenderer === "elk"
      ) {
        return false;
      }
      return graphPattern.test(text);
    },
    loader: async () => ({
      id: "flowchart",
      diagram: flowchartDiagram,
    }),
  },
];

let workflowMermaidPromise: Promise<Mermaid> | null = null;

export function getWorkflowMermaid(): Promise<Mermaid> {
  workflowMermaidPromise ??= mermaid
    .registerExternalDiagrams(flowchartDetectors)
    .then(() => mermaid);

  return workflowMermaidPromise;
}
