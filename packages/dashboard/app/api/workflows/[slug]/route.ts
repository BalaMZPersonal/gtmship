import { NextResponse } from "next/server";
import { deleteWorkflowDeploymentRecords } from "@/lib/workflow-studio/auth-service";
import {
  deleteStoredWorkflow,
  loadStoredWorkflow,
} from "@/lib/workflow-studio/storage";
import type { StoredWorkflowRecord } from "@/lib/workflow-studio/types";

function statusForWorkflowError(error: unknown): number {
  if (!(error instanceof Error)) {
    return 404;
  }

  return /not configured/i.test(error.message) ? 400 : 404;
}

export async function GET(
  _request: Request,
  { params }: { params: { slug: string } }
) {
  try {
    const workflow = await loadStoredWorkflow(params.slug);
    return NextResponse.json(workflow);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load workflow.",
      },
      { status: statusForWorkflowError(error) }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { slug: string } }
) {
  let workflow: StoredWorkflowRecord;
  try {
    workflow = await loadStoredWorkflow(params.slug);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load workflow.",
      },
      { status: statusForWorkflowError(error) }
    );
  }

  let removeDeployment = false;
  try {
    const rawBody = await request.text();
    if (rawBody) {
      const body = JSON.parse(rawBody) as { removeDeployment?: boolean };
      removeDeployment = body.removeDeployment === true;
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid delete request body." },
      { status: 400 }
    );
  }

  let removedDeploymentCount = 0;
  if (removeDeployment) {
    try {
      const result = await deleteWorkflowDeploymentRecords(workflow.workflowId);
      removedDeploymentCount = result.deletedDeploymentCount;
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to remove workflow deployment records.",
        },
        { status: 502 }
      );
    }
  }

  try {
    await deleteStoredWorkflow(params.slug);
    return NextResponse.json({
      slug: workflow.slug,
      workflowId: workflow.workflowId,
      removedDeploymentCount,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete workflow.",
      },
      { status: statusForWorkflowError(error) }
    );
  }
}
