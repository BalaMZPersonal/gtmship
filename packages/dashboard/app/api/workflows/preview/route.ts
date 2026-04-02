import { NextResponse } from "next/server";
import { previewWorkflowArtifact } from "@/lib/workflow-studio/preview";
import { saveStoredWorkflow } from "@/lib/workflow-studio/storage";
import type { WorkflowStudioArtifact } from "@/lib/workflow-studio/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      artifact?: WorkflowStudioArtifact;
      approvedCheckpoints?: string[];
    };

    if (!body.artifact) {
      return NextResponse.json(
        { error: "An artifact is required for preview." },
        { status: 400 }
      );
    }

    const preview = await previewWorkflowArtifact(
      {
        slug: body.artifact.slug,
        code: body.artifact.code,
        samplePayload: body.artifact.samplePayload,
      },
      body.approvedCheckpoints || []
    );

    if (preview.status === "error") {
      console.error("[preview] Workflow preview error:", preview.error);
    } else {
      console.log(
        `[preview] status=${preview.status} ops=${preview.operations.length}` +
          (preview.pendingApproval
            ? ` pending=${preview.pendingApproval.checkpoint}`
            : "")
      );
    }

    const saved = await saveStoredWorkflow({
      ...body.artifact,
      preview,
    });

    return NextResponse.json({
      artifact: saved.artifact,
      preview,
    });
  } catch (error) {
    console.error("[preview] Unhandled error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Workflow preview failed.",
      },
      { status: 400 }
    );
  }
}
