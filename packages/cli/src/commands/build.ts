import { execSync, type ExecSyncOptions } from "node:child_process";
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

interface BrewInstallOptions {
  cask?: boolean;
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
// Enriched PATH for child processes
// ---------------------------------------------------------------------------

/**
 * Build an env object whose PATH includes common locations for `docker` and
 * `gcloud` on macOS and Linux (Homebrew, Docker Desktop, and common Cloud SDK
 * install paths). This ensures child processes can find these binaries even
 * when the CLI is launched from a minimal shell environment, such as the
 * packaged Homebrew app launcher.
 */
export function resolveToolPathCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const homebrewPrefix = env.HOMEBREW_PREFIX || "";
  return Array.from(
    new Set(
      [
        homebrewPrefix ? join(homebrewPrefix, "bin") : "",
        homebrewPrefix ? join(homebrewPrefix, "share", "google-cloud-sdk", "bin") : "",
        "/opt/homebrew/bin",
        "/opt/homebrew/share/google-cloud-sdk/bin",
        "/usr/local/bin",
        "/usr/local/share/google-cloud-sdk/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/home/linuxbrew/.linuxbrew/share/google-cloud-sdk/bin",
        "/Applications/Docker.app/Contents/Resources/bin",
        join(env.HOME || "", "google-cloud-sdk", "bin"),
        "/usr/local/google-cloud-sdk/bin",
      ].filter(Boolean),
    ),
  );
}

export function buildEnrichedEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const extra = resolveToolPathCandidates(baseEnv);
  const currentPath = baseEnv.PATH || "";
  const existingDirs = new Set(currentPath.split(":"));
  const additions = extra.filter((p) => !existingDirs.has(p));
  const pathParts = currentPath ? [currentPath, ...additions] : additions;

  return {
    ...baseEnv,
    PATH: pathParts.join(":"),
  };
}

/** Wrapper around execSync that always uses the enriched PATH. */
function execWithPath(command: string, options?: ExecSyncOptions): string | Buffer {
  return execSync(command, {
    ...options,
    env: buildEnrichedEnv({ ...process.env, ...options?.env }),
  });
}

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

function isDockerCliInstalled(): boolean {
  try {
    execWithPath("docker --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isDockerDaemonRunning(): boolean {
  try {
    execWithPath("docker info", { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function isColimaInstalled(): boolean {
  try {
    execWithPath("colima version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isColimaRunning(): boolean {
  try {
    const output = execWithPath("colima status", { stdio: "pipe", encoding: "utf-8", timeout: 5_000 });
    return typeof output === "string" && output.includes("Running");
  } catch {
    return false;
  }
}

function isRunningUnderHomebrew(): boolean {
  const installRoot = process.env.GTMSHIP_INSTALL_ROOT || "";
  return (
    installRoot.includes("/Cellar/") ||
    installRoot.includes("/homebrew/") ||
    installRoot.includes("/linuxbrew/")
  );
}

function isGcloudInstalled(): boolean {
  try {
    execWithPath("gcloud --version", { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function brewInstall(packages: string[], options: BrewInstallOptions = {}): void {
  const brewBin = process.env.HOMEBREW_PREFIX
    ? join(process.env.HOMEBREW_PREFIX, "bin", "brew")
    : process.platform === "darwin"
      ? "/opt/homebrew/bin/brew"
      : "/home/linuxbrew/.linuxbrew/bin/brew";

  const installArgs = [options.cask ? "--cask" : "", ...packages].filter(Boolean);
  console.log(
    chalk.gray(
      `  Installing ${packages.join(", ")} via Homebrew${options.cask ? " cask" : ""}...`,
    ),
  );
  execWithPath(`${brewBin} install ${installArgs.join(" ")}`, {
    stdio: "inherit",
    timeout: 300_000, // 5 minutes for install
  });
}

function ensureGcloudAvailable(): void {
  if (isGcloudInstalled()) {
    return;
  }

  if (isRunningUnderHomebrew() && process.platform === "darwin") {
    try {
      brewInstall(["gcloud-cli"], { cask: true });
    } catch (err) {
      throw new Error(
        `Failed to auto-install Google Cloud CLI via Homebrew. Install manually: brew install --cask gcloud-cli\n` +
        `  ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (isGcloudInstalled()) {
      return;
    }
  }

  const installCommand =
    process.platform === "darwin"
      ? "brew install --cask gcloud-cli"
      : "Install the Google Cloud CLI for your platform";

  throw new Error(
    "Google Cloud CLI (`gcloud`) is required to push workflow images to Artifact Registry.\n" +
    `  Install it with: ${installCommand}\n` +
    "  GTMShip searches common Homebrew and Cloud SDK paths automatically, including\n" +
    "  /opt/homebrew/bin and /opt/homebrew/share/google-cloud-sdk/bin.",
  );
}

/**
 * Ensure Docker is available (CLI installed + daemon running).
 * On macOS, auto-installs docker/colima via Homebrew if needed,
 * then auto-starts colima if the daemon isn't running.
 * Throws with an actionable message if Docker cannot be made available.
 */
export function ensureDockerAvailable(): void {
  const isBrew = isRunningUnderHomebrew();

  // 1. Ensure Docker CLI is installed
  if (!isDockerCliInstalled()) {
    if (isBrew) {
      const toInstall = ["docker"];
      if (process.platform === "darwin" && !isColimaInstalled()) {
        toInstall.push("colima");
      }
      try {
        brewInstall(toInstall);
      } catch (err) {
        throw new Error(
          `Failed to auto-install Docker via Homebrew. Install manually: brew install docker colima\n` +
          `  ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (!isDockerCliInstalled()) {
        throw new Error(
          "Docker CLI is still not available after brew install. Try: brew install docker"
        );
      }
    } else {
      throw new Error(
        "Docker CLI is not installed. Install it with: brew install docker colima"
      );
    }
  }

  // 2. Check if daemon is already running
  if (isDockerDaemonRunning()) {
    return;
  }

  // 3. Docker CLI exists but daemon is not running
  if (process.platform === "darwin") {
    // Ensure colima is installed
    if (!isColimaInstalled()) {
      if (isBrew) {
        try {
          brewInstall(["colima"]);
        } catch (err) {
          throw new Error(
            `Failed to auto-install colima via Homebrew. Install manually: brew install colima\n` +
            `  ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        throw new Error(
          "Docker CLI is installed but the Docker daemon is not running.\n" +
          "  Install colima to run Docker on macOS: brew install colima\n" +
          "  Then start it with: colima start"
        );
      }
    }

    // Start colima
    if (!isColimaRunning()) {
      console.log(chalk.gray("  Starting colima (Docker runtime for macOS)..."));
      try {
        execWithPath("colima start", { stdio: "pipe", timeout: 120_000 });
      } catch (err) {
        throw new Error(
          "Failed to auto-start colima. Start it manually with: colima start\n" +
          `  ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Verify daemon is now reachable
    if (!isDockerDaemonRunning()) {
      throw new Error(
        "Colima is running but Docker daemon is not reachable.\n" +
        "  Try: colima stop && colima start"
      );
    }

    return;
  }

  // Linux — daemon should be running via systemd
  throw new Error(
    "Docker daemon is not running. Start it with: sudo systemctl start docker"
  );
}

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
  // Prefer the compiled output for packaged installs, then fall back to source
  // when contributors run directly from a workspace checkout.
  const sdkRoot = resolveSdkRoot();

  const jsPath = join(sdkRoot, "dist", "runner.js");
  if (existsSync(jsPath)) return jsPath;

  const tsPath = join(sdkRoot, "src", "runner.ts");
  if (existsSync(tsPath)) return tsPath;

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
  execWithPath(`docker build --platform ${CLOUD_RUN_IMAGE_PLATFORM} -t ${imageTag} ${outDir}`, {
    stdio: "pipe",
    timeout: DOCKER_BUILD_TIMEOUT_MS,
  });

  return imageTag;
}

function ensureArtifactRegistryRepo(
  gcpProject: string,
  region: string,
): void {
  ensureGcloudAvailable();

  const repoName = "gtmship-workflows";
  // Check if repo already exists (fast path)
  try {
    execWithPath(
      `gcloud artifacts repositories describe ${repoName} --location=${region} --project=${gcpProject}`,
      { stdio: "pipe", timeout: GCLOUD_TIMEOUT_MS },
    );
    return; // Already exists
  } catch {
    // Doesn't exist — create it
  }

  execWithPath(
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

  execWithPath(`docker tag ${localTag} ${remoteTag}`, { stdio: "pipe" });

  // Retry docker push with exponential backoff for transient network errors
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DOCKER_PUSH_MAX_RETRIES; attempt++) {
    try {
      execWithPath(`docker push ${remoteTag}`, {
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
  if (options.provider === "gcp") {
    ensureDockerAvailable();
  }

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
