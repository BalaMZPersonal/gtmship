import { NextResponse } from "next/server";
import { listStoredWorkflows } from "@/lib/workflow-studio/storage";

export async function GET() {
  try {
    const response = await listStoredWorkflows();
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list workflows.",
      },
      { status: 500 }
    );
  }
}
