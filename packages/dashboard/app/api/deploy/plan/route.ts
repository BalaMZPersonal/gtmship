import { NextResponse } from "next/server";
import { listActiveConnections } from "@/lib/workflow-studio/auth-service";
import { buildWorkflowDeploymentPlanForArtifact } from "@/lib/workflow-studio/deployment";
import {
  listStoredWorkflows,
  loadStoredWorkflow,
} from "@/lib/workflow-studio/storage";
import type {
  WorkflowDeployProvider,
  WorkflowDeploymentPlan,
} from "@/lib/workflow-studio/types";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider") as
      | WorkflowDeployProvider
      | null;
    const region = url.searchParams.get("region") || undefined;
    const gcpProject = url.searchParams.get("gcpProject") || undefined;

    const listing = await listStoredWorkflows();
    if (!listing.projectRootConfigured) {
      return NextResponse.json({
        projectRootConfigured: false,
        provider: provider || "aws",
        region: region || (provider === "gcp" ? "us-central1" : "us-east-1"),
        gcpProject,
        plans: [],
      });
    }

    const connections = await listActiveConnections();
    const plans: WorkflowDeploymentPlan[] = [];

    for (const workflow of listing.workflows) {
      const record = await loadStoredWorkflow(workflow.slug);
      plans.push(
        buildWorkflowDeploymentPlanForArtifact({
          artifact: record.artifact,
          connections,
          provider: provider || undefined,
          region,
          gcpProject,
        })
      );
    }

    return NextResponse.json({
      projectRootConfigured: true,
      projectName: listing.projectName,
      provider: provider || "aws",
      region: region || (provider === "gcp" ? "us-central1" : "us-east-1"),
      gcpProject,
      plans,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load deployment plans.",
      },
      { status: 500 }
    );
  }
}
