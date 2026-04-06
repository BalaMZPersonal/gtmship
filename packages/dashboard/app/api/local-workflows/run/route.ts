import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { resolveCliInvocation } from "@/lib/runtime/cli";
import { resolveProjectRoot } from "@/lib/workflow-studio/project-root";
import { loadStoredWorkflow } from "@/lib/workflow-studio/storage";

const LOCAL_RUN_TIMEOUT_MS = 5 * 60 * 1000;

function parseJsonOutput(
  raw: string
): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      workflowId?: string;
      workflowSlug?: string;
      payload?: unknown;
    };

    const workflowId =
      typeof body.workflowId === "string" && body.workflowId.trim()
        ? body.workflowId.trim()
        : typeof body.workflowSlug === "string" && body.workflowSlug.trim()
          ? (await loadStoredWorkflow(body.workflowSlug.trim())).workflowId
          : "";

    if (!workflowId) {
      return NextResponse.json(
        { error: "A workflowId or workflowSlug is required." },
        { status: 400 }
      );
    }

    const resolution = await resolveProjectRoot();
    const cliInvocation = resolveCliInvocation();
    const projectRoot =
      resolution.projectRoot || process.env.PROJECT_ROOT || process.cwd();
    const args = [
      ...cliInvocation.baseArgs,
      "local",
      "run",
      workflowId,
      "--json",
    ];

    if (body.payload !== undefined) {
      args.push("--payload", JSON.stringify(body.payload));
    }

    return await new Promise<NextResponse>((resolve) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      let settled = false;
      const child = spawn(cliInvocation.command, args, {
        cwd: projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, LOCAL_RUN_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        settled = true;
        const stdoutText = stdout.join("");
        const stderrText = stderr.join("");
        const combinedOutput = `${stdoutText}${stderrText}`;
        const parsed = parseJsonOutput(stdoutText);

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          resolve(
            NextResponse.json(
              {
                error: `Local workflow run timed out after ${LOCAL_RUN_TIMEOUT_MS / 60000} minutes.`,
                workflowId,
                output: combinedOutput,
              },
              { status: 504 }
            )
          );
          return;
        }

        if (code === 0) {
          resolve(
            NextResponse.json(
              parsed || {
                success: true,
                workflowId,
                output: combinedOutput,
                status: "success",
              }
            )
          );
          return;
        }

        resolve(
          NextResponse.json(
            parsed || {
              error: "Local workflow run failed.",
              workflowId,
              output: combinedOutput,
              status: "failure",
            },
            { status: 500 }
          )
        );
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        settled = true;
        resolve(
          NextResponse.json(
            {
              error: `Failed to start local workflow run: ${error.message}`,
              workflowId,
            },
            { status: 500 }
          )
        );
      });
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to run the local workflow.",
      },
      { status: 500 }
    );
  }
}
