import { NextResponse } from "next/server";
import {
  buildWorkflowArtifact,
  repairWorkflowBuildFailure,
} from "@/lib/workflow-studio/build";
import { buildWorkflowPlanFromArtifact } from "@/lib/workflow-studio/deploy-plan";
import { loadProjectDeploymentDefaults } from "@/lib/workflow-studio/project-config";
import { saveStoredWorkflow } from "@/lib/workflow-studio/storage";
import type { WorkflowStudioArtifact } from "@/lib/workflow-studio/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      artifact?: WorkflowStudioArtifact;
      approvedCheckpoints?: string[];
      repair?: boolean;
    };

    if (!body.artifact) {
      return NextResponse.json(
        { error: "An artifact is required for build." },
        { status: 400 }
      );
    }

    const artifact = body.artifact;
    const defaults = await loadProjectDeploymentDefaults();
    const resolved = body.repair
      ? await repairWorkflowBuildFailure({
          artifact,
          approvedCheckpoints: body.approvedCheckpoints || [],
          defaults,
        })
      : await (async () => {
          const build = await buildWorkflowArtifact({
            artifact,
            approvedCheckpoints: body.approvedCheckpoints || [],
            defaults,
          });

          return {
            artifact: {
              ...artifact,
              validation: build.validation || artifact.validation,
              preview: build.preview || artifact.preview,
              build,
              deploymentPlan: buildWorkflowPlanFromArtifact(artifact, defaults),
            },
            build,
            repaired: false,
            assistantMessage: undefined,
            blockedAccesses: undefined,
          };
        })();
    const repairAssistantMessage =
      "assistantMessage" in resolved ? resolved.assistantMessage : undefined;
    const artifactToSave: WorkflowStudioArtifact =
      resolved.repaired && repairAssistantMessage
        ? {
            ...resolved.artifact,
            messages: [
              ...(resolved.artifact.messages || []),
              {
                id: `workflow-build-repair-${Date.now()}`,
                role: "assistant",
                content: repairAssistantMessage,
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : resolved.artifact;
    const saved = await saveStoredWorkflow(artifactToSave);
    const build = resolved.build;

    if (build.status === "error") {
      console.error("[build] Workflow build failed:", build.error);
    } else {
      console.log(
        `[build] Workflow build succeeded: ${build.provider} ${build.artifact?.artifactPath || ""}`.trim()
      );
    }

    return NextResponse.json({
      ...resolved,
      artifact: saved.artifact,
    });
  } catch (error) {
    console.error("[build] Unhandled error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Workflow build failed.",
      },
      { status: 400 }
    );
  }
}
