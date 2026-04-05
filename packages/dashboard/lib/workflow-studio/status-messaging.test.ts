import { describe, expect, it } from "vitest";
import {
  didUserExplicitlyRequestBuild,
  formatBuildStatusMessage,
  formatDraftStatusMessage,
  formatPreviewStatusMessage,
} from "@/lib/workflow-studio/status-messaging";
import type { WorkflowStudioMessage } from "@/lib/workflow-studio/types";

describe("workflow status messaging", () => {
  it("describes a successful draft preview without claiming build or deploy", () => {
    const message = formatDraftStatusMessage({
      status: "success",
      operations: [
        {
          id: "preview_1",
          source: "integration",
          target: "github",
          url: "http://localhost:4000/proxy/github/issues",
          method: "GET",
          mode: "read",
          responseStatus: 200,
        },
      ],
    });

    expect(message).toContain("Draft generated.");
    expect(message).toContain("tested 1 non-write API call(s)");
    expect(message).toContain("Not built. Not deployed.");
  });

  it("describes preview approval without claiming build or deploy", () => {
    const message = formatDraftStatusMessage({
      status: "needs_approval",
      operations: [
        {
          id: "preview_1",
          source: "integration",
          target: "github",
          url: "http://localhost:4000/proxy/github/issues",
          method: "GET",
          mode: "read",
          responseStatus: 200,
        },
        {
          id: "preview_2",
          source: "integration",
          target: "google-sheets",
          url: "http://localhost:4000/proxy/google-sheets/append",
          method: "POST",
          mode: "write",
          checkpoint: "append-to-sheets",
        },
      ],
      pendingApproval: {
        checkpoint: "append-to-sheets",
        target: "google-sheets",
        method: "POST",
        source: "integration",
      },
    });

    expect(message).toContain('paused at checkpoint "append-to-sheets"');
    expect(message).toContain("Approve it in Preview to continue.");
    expect(message).toContain("Not built. Not deployed.");
  });

  it("describes a completed build as not deployed", () => {
    const message = formatBuildStatusMessage({
      status: "success",
      provider: "gcp",
      region: "us-central1",
      gcpProject: "demo-project",
      builtAt: "2026-04-05T00:00:00.000Z",
      steps: [],
      preview: {
        status: "success",
        operations: [],
      },
      artifact: {
        workflowId: "demo-workflow",
        provider: "gcp",
        artifactPath: "/tmp/demo-workflow",
        bundleSizeBytes: 0,
      },
    });

    expect(message).toContain("Build completed and packaged an artifact.");
    expect(message).toContain("This did not deploy the workflow.");
  });

  it("describes preview approvals as UI-only", () => {
    const message = formatPreviewStatusMessage({
      status: "needs_approval",
      operations: [],
      pendingApproval: {
        checkpoint: "append-to-sheets",
        target: "google-sheets",
        method: "POST",
        source: "integration",
      },
    });

    expect(message).toContain("The user must approve this");
  });

  it("only treats an explicit build request as permission to build", () => {
    const createMessages: WorkflowStudioMessage[] = [
      {
        id: "msg-create",
        role: "user",
        content: "Create a workflow for GitHub issues",
      },
    ];
    const buildMessages: WorkflowStudioMessage[] = [
      {
        id: "msg-build",
        role: "user",
        content: "Build the workflow now",
      },
    ];

    expect(
      didUserExplicitlyRequestBuild(createMessages)
    ).toBe(false);

    expect(didUserExplicitlyRequestBuild(buildMessages)).toBe(true);
  });
});
