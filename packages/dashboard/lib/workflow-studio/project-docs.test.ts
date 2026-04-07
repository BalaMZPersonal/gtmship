import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { searchProjectFilesWithoutRipgrep } from "./project-docs";

describe("searchProjectFilesWithoutRipgrep", () => {
  it("finds matching files without ripgrep", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "gtmship-project-docs-"),
    );
    await mkdir(path.join(projectRoot, "workflows"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "workflows", "sync.ts"),
      `export const workflow = "gmail sync";\nconst provider = "google-sheets";\n`,
      "utf8",
    );

    const matches = await searchProjectFilesWithoutRipgrep(projectRoot, {
      query: "google-sheets",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toContain(path.join("workflows", "sync.ts"));
    expect(matches[0]?.line).toBe(2);
  });

  it("respects a glob filter", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "gtmship-project-docs-"),
    );
    await mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await mkdir(path.join(projectRoot, "workflows"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "docs", "notes.md"),
      "google-sheets shows up here too\n",
      "utf8",
    );
    await writeFile(
      path.join(projectRoot, "workflows", "sync.ts"),
      `const provider = "google-sheets";\n`,
      "utf8",
    );

    const matches = await searchProjectFilesWithoutRipgrep(projectRoot, {
      query: "google-sheets",
      glob: "workflows/*.ts",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toContain(path.join("workflows", "sync.ts"));
  });
});
