import { z } from "zod";
import { summarizeWorkflowTranscriptMessages } from "@/lib/workflow-studio/transcript-compaction-server";
import type {
  WorkflowStudioArtifact,
  WorkflowStudioMessage,
} from "@/lib/workflow-studio/types";

const messageSchema = z.object({
  id: z.string().optional(),
  role: z.string(),
  content: z.string().optional(),
  createdAt: z.string().optional(),
  parts: z.array(z.any()).optional(),
  toolInvocations: z.array(z.any()).optional(),
  annotations: z.array(z.any()).optional(),
});

const requestSchema = z.object({
  previousSummary: z.string().optional(),
  messagesToCompact: z.array(messageSchema).default([]),
  currentArtifact: z.any().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const summary = await summarizeWorkflowTranscriptMessages({
      previousSummary: body.previousSummary,
      messagesToCompact: body.messagesToCompact as WorkflowStudioMessage[],
      currentArtifact:
        body.currentArtifact && typeof body.currentArtifact === "object"
          ? (body.currentArtifact as WorkflowStudioArtifact)
          : null,
    });

    return Response.json({ summary });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Workflow transcript compaction failed.",
      },
      { status: 400 }
    );
  }
}
