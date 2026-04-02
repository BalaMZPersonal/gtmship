import { NextResponse } from "next/server";
import { validateWorkflowArtifact } from "@/lib/workflow-studio/validate";
import type { WorkflowStudioArtifact } from "@/lib/workflow-studio/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      artifact?: WorkflowStudioArtifact;
    };

    if (!body.artifact) {
      return NextResponse.json(
        { error: "An artifact is required for validation." },
        { status: 400 }
      );
    }

    const validation = validateWorkflowArtifact({
      slug: body.artifact.slug,
      code: body.artifact.code,
      writeCheckpoints: body.artifact.writeCheckpoints,
    });

    return NextResponse.json(validation);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Workflow validation failed.",
      },
      { status: 400 }
    );
  }
}
