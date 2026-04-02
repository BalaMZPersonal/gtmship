import { NextResponse } from "next/server";
import {
  listProjects,
  createProject,
} from "@/lib/workflow-studio/project-root";
import { getSetting } from "@/lib/workflow-studio/auth-service";

export async function GET() {
  try {
    const projects = await listProjects();
    const activeRoot = await getSetting("project_root");
    return NextResponse.json({ projects, activeRoot });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list projects.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { name } = (await request.json()) as { name?: string };
    if (!name?.trim()) {
      return NextResponse.json(
        { error: "Project name is required." },
        { status: 400 }
      );
    }
    const project = await createProject(name);
    return NextResponse.json(project);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create project.",
      },
      { status: 500 }
    );
  }
}
