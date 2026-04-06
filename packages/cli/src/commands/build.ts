import { execSync } from "node:child_process";
import { createWriteStream, cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import chalk from "chalk";
import ora from "ora";
import {
  loadWorkflowPlans,
  readProjectConfig,
  type WorkflowPlanRecord,
} from "../lib/workflow-plans.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BuildOptions {
  workflow?: string;
  provider?: string;
  push?: boolean;
  project?: string;
  region?: string;
}

export interface BuildArtifact {
  workflowId: string;
  provider: "aws" | "gcp" | "local";
  artifactPath: string;
  imageUri?: string;
  bundleSizeBytes: number;
}

interface BuildWorkflowsOptions {
  provider: "aws" | "gcp" | "local";
  gcpProject?: string;
  region?: string;
  push?: boolean;
}

const CLOUD_RUN_IMAGE_PLATFORM = "linux/amd64";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for `docker build` (5 minutes). */
const DOCKER_BUILD_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for `docker push` per attempt (3 minutes). */
const DOCKER_PUSH_TIMEOUT_MS = 3 * 60 * 1000;

/** Max retries for transient Docker push failures (network, proxy, timeout). */
const DOCKER_PUSH_MAX_RETRIES = 3;

/** Timeout for gcloud CLI calls (30 seconds). */
const GCLOUD_TIMEOUT_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTransientDockerError(message: string): boolean {
  const transientPatterns = [
    /i\/o timeout/i,
    /connection reset/i,
    /connection refused/i,
    /proxyconnect/i,
    /dial tcp/i,
    /TLS handshake timeout/i,
    /EOF/,
    /ETIMEDOUT/,
    /ECONNRESET/,
    /ECONNREFUSED/,
    /server misbehaving/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
  ];
  return transientPatterns.some((pattern) => pattern.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateVersionTag(): string {
  let gitSha = "nogit";
  try {
    gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Not a git repo — use fallback.
  }
  return `${gitSha}-${Math.floor(Date.now() / 1000)}`;
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function resolveSdkRoot(): string {
  const require = createRequire(import.meta.url);
  const sdkPkgPath = require.resolve("@gtmship/sdk/package.json");
  return dirname(sdkPkgPath);
}

/**
 * Collect node_modules directories that esbuild should search when resolving
 * bare-specifier imports like `@gtmship/sdk`. The CLI itself has the SDK as
 * a workspace dependency, so we walk up from the CLI's location to find all
 * ancestor node_modules paths.
 */
function resolveNodePaths(): string[] {
  const paths: string[] = [];
  let dir = dirname(new URL(import.meta.url).pathname);
  while (dir !== dirname(dir)) {
    const nm = join(dir, "node_modules");
    if (existsSync(nm)) paths.push(nm);
    dir = dirname(dir);
  }
  return paths;
}

function resolveRunnerEntrypoint(): string {
  // Resolve the runner source from the SDK package.
  // Try the source .ts first (for monorepo dev), fall back to compiled .js.
  const sdkRoot = resolveSdkRoot();

  const tsPath = join(sdkRoot, "src", "runner.ts");
  if (existsSync(tsPath)) return tsPath;

  const jsPath = join(sdkRoot, "dist", "runner.js");
  if (existsSync(jsPath)) return jsPath;

  throw new Error(
    "Cannot find @gtmship/sdk runner entrypoint. Ensure the SDK is installed.",
  );
}

function resolveDockerfile(): string {
  const sdkRoot = resolveSdkRoot();
  const dockerfilePath = join(sdkRoot, "Dockerfile.cloudrun");

  if (!existsSync(dockerfilePath)) {
    throw new Error(
      "Cannot find Dockerfile.cloudrun in @gtmship/sdk. Ensure the SDK is installed.",
    );
  }

  return dockerfilePath;
}

// ---------------------------------------------------------------------------
// esbuild bundling
// ---------------------------------------------------------------------------

async function bundleWorkflow(
  workflowPath: string,
  provider: "aws" | "gcp" | "local",
  outDir: string,
): Promise<void> {
  const esbuild = await import("esbuild");
  const nodePaths = resolveNodePaths();

  // CommonJS packages (e.g. @google-cloud/secret-manager) use require(),
  // __dirname, and __filename. In ESM bundles these are undefined, so we
  // inject shims via banner.
  const esmRequireBanner = {
    js: [
      "import { createRequire as __esbuild_createRequire } from 'module';",
      "import { fileURLToPath as __esbuild_fileURLToPath } from 'url';",
      "import { dirname as __esbuild_dirname } from 'path';",
      "const require = __esbuild_createRequire(import.meta.url);",
      "const __filename = __esbuild_fileURLToPath(import.meta.url);",
      "const __dirname = __esbuild_dirname(__filename);",
    ].join("\n"),
  };

  // Bundle the user's workflow code + SDK into workflow.js
  await esbuild.build({
    entryPoints: [workflowPath],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(outDir, "workflow.js"),
    banner: esmRequireBanner,
    external:
      provider === "aws"
        ? ["@aws-sdk/*"] // pre-installed in Lambda runtime
        : [], // bundle everything for Cloud Run
    nodePaths, // resolve @gtmship/sdk from the monorepo's node_modules
    sourcemap: true,
    treeShaking: true,
    minify: false, // keep readable for debugging
    logLevel: "warning",
  });

  // Bundle the runner entrypoint separately
  const runnerPath = resolveRunnerEntrypoint();
  await esbuild.build({
    entryPoints: [runnerPath],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(outDir, "runner.js"),
    banner: esmRequireBanner,
    external:
      provider === "aws"
        ? ["@aws-sdk/*", "./workflow.js"]
        : ["./workflow.js"], // always external — loaded at runtime via dynamic import
    nodePaths,
    sourcemap: true,
    treeShaking: true,
    minify: false,
    logLevel: "warning",
  });
}

// ---------------------------------------------------------------------------
// AWS Lambda zip packaging
// ---------------------------------------------------------------------------

async function packageForLambda(
  outDir: string,
  workflowId: string,
  buildRoot: string,
): Promise<string> {
  const archiver = (await import("archiver")).default;
  const zipDir = join(buildRoot, workflowId);
  ensureDir(zipDir);
  const zipPath = join(zipDir, "lambda.zip");

  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  const done = pipeline(archive, output);

  // Lambda expects index.handler — rename runner.js → index.mjs
  archive.file(join(outDir, "runner.js"), { name: "index.mjs" });
  if (existsSync(join(outDir, "runner.js.map"))) {
    archive.file(join(outDir, "runner.js.map"), { name: "index.mjs.map" });
  }
  archive.file(join(outDir, "workflow.js"), { name: "workflow.js" });
  if (existsSync(join(outDir, "workflow.js.map"))) {
    archive.file(join(outDir, "workflow.js.map"), { name: "workflow.js.map" });
  }

  await archive.finalize();
  await done;

  return zipPath;
}

// ---------------------------------------------------------------------------
// GCP Docker image build & push
// ---------------------------------------------------------------------------

function buildDockerImage(
  outDir: string,
  workflowId: string,
  versionTag: string,
): string {
  const dockerfileSrc = resolveDockerfile();
  const imageTag = `gtmship-${workflowId}:${versionTag}`;

  // Create a dist/ subdirectory matching what the Dockerfile expects
  const distDir = join(outDir, "dist");
  ensureDir(distDir);

  // Copy bundled files into dist/
  for (const file of ["runner.js", "runner.js.map", "workflow.js", "workflow.js.map"]) {
    const src = join(outDir, file);
    if (existsSync(src)) {
      cpSync(src, join(distDir, file));
    }
  }

  // Copy Dockerfile into the build context
  cpSync(dockerfileSrc, join(outDir, "Dockerfile"));

  // Cloud Run requires an amd64-compatible Linux image even when developers
  // build locally from Apple Silicon hosts.
  execSync(`docker build --platform ${CLOUD_RUN_IMAGE_PLATFORM} -t ${imageTag} ${outDir}`, {
    stdio: "pipe",
    timeout: DOCKER_BUILD_TIMEOUT_MS,
  });

  return imageTag;
}

function ensureArtifactRegistryRepo(
  gcpProject: string,
  region: string,
): void {
  const repoName = "gtmship-workflows";
  // Check if repo already exists (fast path)
  try {
    execSync(
      `gcloud artifacts repositories describe ${repoName} --location=${region} --project=${gcpProject}`,
      { stdio: "pipe", timeout: GCLOUD_TIMEOUT_MS },
    );
    return; // Already exists
  } catch {
    // Doesn't exist — create it
  }

  execSync(
    `gcloud artifacts repositories create ${repoName} --repository-format=docker --location=${region} --project=${gcpProject} --description="GTMShip workflow images"`,
    { stdio: "pipe", timeout: GCLOUD_TIMEOUT_MS },
  );
}

async function pushToArtifactRegistry(
  localTag: string,
  gcpProject: string,
  region: string,
  workflowId: string,
  versionTag: string,
): Promise<string> {
  const registry = `${region}-docker.pkg.dev`;
  const repoName = "gtmship-workflows";

  // Ensure the Artifact Registry repo exists before pushing
  ensureArtifactRegistryRepo(gcpProject, region);

  const remoteTag = `${registry}/${gcpProject}/${repoName}/${workflowId}:${versionTag}`;

  execSync(`docker tag ${localTag} ${remoteTag}`, { stdio: "pipe" });

  // Retry docker push with exponential backoff for transient network errors
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DOCKER_PUSH_MAX_RETRIES; attempt++) {
    try {
      execSync(`docker push ${remoteTag}`, {
        stdio: "inherit",
        timeout: DOCKER_PUSH_TIMEOUT_MS,
      });
      return remoteTag;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const message = lastError.message || "";

      if (!isTransientDockerError(message) || attempt === DOCKER_PUSH_MAX_RETRIES) {
        break;
      }

      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.log(
        `  Docker push attempt ${attempt}/${DOCKER_PUSH_MAX_RETRIES} failed (${message.split("\n")[0]}). Retrying in ${backoffMs / 1000}s...`,
      );
      await sleep(backoffMs);
    }
  }

  throw new Error(
    `Docker push failed after ${DOCKER_PUSH_MAX_RETRIES} attempts: ${lastError?.message || "unknown error"}`,
  );
}

// ---------------------------------------------------------------------------
// Public API — called by deploy.ts programmatically
// ---------------------------------------------------------------------------

export async function buildWorkflows(
  workflowPlans: WorkflowPlanRecord[],
  options: BuildWorkflowsOptions,
): Promise<BuildArtifact[]> {
  const buildRoot = join(process.cwd(), ".gtmship", "build");
  ensureDir(buildRoot);
  const versionTag = generateVersionTag();
  const artifacts: BuildArtifact[] = [];

  for (const wp of workflowPlans) {
    const outDir = join(buildRoot, wp.workflowId, "bundle");
    ensureDir(outDir);

    // 1. Bundle with esbuild
    await bundleWorkflow(wp.filePath, options.provider, outDir);

    let artifactPath: string;
    let imageUri: string | undefined;

    if (options.provider === "aws") {
      // 2a. Package as Lambda zip
      artifactPath = await packageForLambda(outDir, wp.workflowId, buildRoot);
    } else if (options.provider === "gcp") {
      // 2b. Build Docker image
      const localTag = buildDockerImage(outDir, wp.workflowId, versionTag);
      artifactPath = localTag;

      // 2c. Push to Artifact Registry if requested
      if (options.push && options.gcpProject) {
        const region = options.region || "us-central1";
        imageUri = await pushToArtifactRegistry(
          localTag,
          options.gcpProject,
          region,
          wp.workflowId,
          versionTag,
        );
        artifactPath = imageUri;
      }
    } else {
      artifactPath = outDir;
    }

    const bundleSize =
      options.provider === "aws"
        ? fileSize(artifactPath)
        : fileSize(join(outDir, "runner.js")) +
          fileSize(join(outDir, "workflow.js"));

    artifacts.push({
      workflowId: wp.workflowId,
      provider: options.provider,
      artifactPath,
      imageUri,
      bundleSizeBytes: bundleSize,
    });
  }

  // Write build manifest
  const manifest = {
    version: 1,
    builtAt: new Date().toISOString(),
    versionTag,
    artifacts: artifacts.map((a) => ({
      workflowId: a.workflowId,
      provider: a.provider,
      artifactPath: a.artifactPath,
      imageUri: a.imageUri,
      bundleSizeBytes: a.bundleSizeBytes,
    })),
  };
  writeFileSync(
    join(buildRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return artifacts;
}

// ---------------------------------------------------------------------------
// CLI action
// ---------------------------------------------------------------------------

export async function buildCommand(options: BuildOptions): Promise<void> {
  console.log(chalk.blue("\n  Building GTMShip workflows...\n"));

  const config = readProjectConfig();
  const provider = (options.provider ||
    config?.deploy?.provider ||
    "aws") as "aws" | "gcp" | "local";
  const region =
    options.region ||
    (provider === "aws"
      ? "us-east-1"
      : provider === "gcp"
        ? "us-central1"
        : "local");
  const gcpProject = options.project || config?.deploy?.gcpProject;

  if (provider === "gcp" && options.push && !gcpProject) {
    console.log(
      chalk.red(
        "  GCP project ID is required for --push. Use --project <id> or set deploy.gcp_project in gtmship.config.yaml",
      ),
    );
    process.exit(1);
  }

  // Check Docker availability for GCP
  if (provider === "gcp") {
    try {
      execSync("docker info", { stdio: "pipe" });
    } catch {
      console.log(
        chalk.red(
          "  Docker is required for GCP builds but was not found. Please install Docker and try again.",
        ),
      );
      process.exit(1);
    }
  }

  const workflowPlans = loadWorkflowPlans(process.cwd(), {
    providerOverride: provider,
    regionOverride: region,
    gcpProjectOverride: gcpProject,
    workflowId: options.workflow,
  });

  if (workflowPlans.length === 0) {
    console.log(
      chalk.yellow(
        options.workflow
          ? `  Workflow "${options.workflow}" not found.`
          : "  No workflows found in ./workflows/.",
      ),
    );
    return;
  }

  console.log(chalk.gray(`  Provider: ${provider.toUpperCase()}`));
  console.log(chalk.gray(`  Region:   ${region}`));
  console.log(
    chalk.gray(
      `  Workflows: ${workflowPlans.map((w) => w.workflowId).join(", ")}`,
    ),
  );
  console.log("");

  const spinner = ora("Bundling workflow code...").start();

  try {
    const artifacts = await buildWorkflows(workflowPlans, {
      provider,
      gcpProject,
      region,
      push: options.push,
    });

    spinner.succeed("Build complete");
    console.log("");

    console.log(chalk.green("  Build Artifacts"));
    console.log(chalk.green("  " + "-".repeat(50)));
    for (const artifact of artifacts) {
      const sizeKb = (artifact.bundleSizeBytes / 1024).toFixed(1);
      console.log(
        chalk.white(`  ${artifact.workflowId} (${sizeKb} KB)`),
      );
      console.log(chalk.gray(`    Path: ${artifact.artifactPath}`));
      if (artifact.imageUri) {
        console.log(chalk.gray(`    Image: ${artifact.imageUri}`));
      }
    }
    console.log("");
  } catch (err) {
    spinner.fail("Build failed");
    console.log(
      chalk.red(
        `\n  ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }
}
