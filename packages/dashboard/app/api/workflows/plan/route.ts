import { NextResponse } from "next/server";
import { listActiveConnections } from "@/lib/workflow-studio/auth-service";
import { buildWorkflowDeploymentPlanForArtifact } from "@/lib/workflow-studio/deployment";
import type {
  WorkflowDeployProvider,
  WorkflowStudioArtifact,
} from "@/lib/workflow-studio/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      artifact?: WorkflowStudioArtifact;
      provider?: WorkflowDeployProvider;
      region?: string;
      gcpProject?: string;
    };

    if (!body.artifact) {
      return NextResponse.json(
        { error: "An artifact is required to compute a deployment plan." },
        { status: 400 }
      );
    }

    const connections = await listActiveConnections();
    const plan = buildWorkflowDeploymentPlanForArtifact({
      artifact: body.artifact,
      connections,
      provider: body.provider,
      region: body.region,
      gcpProject: body.gcpProject,
    });

    return NextResponse.json(plan);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to compute deployment plan.",
      },
      { status: 400 }
    );
  }
}
