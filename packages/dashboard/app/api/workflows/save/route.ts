import { NextResponse } from "next/server";
import { saveStoredWorkflow } from "@/lib/workflow-studio/storage";
import { validateWorkflowArtifact } from "@/lib/workflow-studio/validate";
import type { WorkflowStudioArtifact } from "@/lib/workflow-studio/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      artifact?: WorkflowStudioArtifact;
    };

    if (!body.artifact) {
      return NextResponse.json(
        { error: "An artifact is required to save." },
        { status: 400 }
      );
    }

    const validation = validateWorkflowArtifact({
      slug: body.artifact.slug,
      code: body.artifact.code,
      writeCheckpoints: body.artifact.writeCheckpoints,
    });

    if (!validation.ok) {
      console.error("[save] Validation failed:", validation.issues);
      return NextResponse.json(
        {
          error: "Workflow must pass validation before saving.",
          validation,
        },
        { status: 400 }
      );
    }

    const saved = await saveStoredWorkflow({
      ...body.artifact,
      validation,
    });

    return NextResponse.json(saved);
  } catch (error) {
    console.error("[save] Unhandled error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save workflow.",
      },
      { status: 400 }
    );
  }
}
