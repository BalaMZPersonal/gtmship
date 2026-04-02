import { NextResponse } from "next/server";
import { loadStoredWorkflow } from "@/lib/workflow-studio/storage";

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
      {
        status:
          error instanceof Error && /not configured/i.test(error.message)
            ? 400
            : 404,
      }
    );
  }
}
