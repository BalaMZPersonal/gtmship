import { createWorkflowAgentResponse } from "@/lib/workflow-studio/agent";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return await createWorkflowAgentResponse(body);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Workflow generation failed.",
      },
      { status: 400 }
    );
  }
}
