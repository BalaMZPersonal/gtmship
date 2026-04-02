import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import net from "node:net";
import chalk from "chalk";
import ora from "ora";

const children: ChildProcess[] = [];
let shuttingDown = false;

function findMonorepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    "Could not find monorepo root (no pnpm-workspace.yaml found). " +
      "Make sure you are running this command from within the GTMShip project."
  );
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  label: string,
  color: (s: string) => string
): void {
  if (!stream) return;
  stream.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      console.log(`${color(`[${label}]`)} ${line}`);
    }
  });
}

function spawnService(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  color: (s: string) => string,
  extraEnv?: Record<string, string>
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      ...extraEnv,
    },
  });

  prefixStream(child.stdout, label, color);
  prefixStream(child.stderr, label, color);

  child.on("error", (err) => {
    console.error(color(`[${label}]`), chalk.red(`Failed to start: ${err.message}`));
  });

  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(
        color(`[${label}]`),
        code === 0
          ? chalk.gray("exited cleanly")
          : chalk.red(`exited with code ${code ?? signal}`)
      );
    }
  });

  children.push(child);
  return child;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: {
        ...process.env,
        FORCE_COLOR: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: stderr + err.message });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };

    server.once("error", () => finish(false));
    server.once("listening", () => {
      server.close(() => finish(true));
    });

    server.listen(port);
  });
}

async function shutdown(root: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(chalk.yellow("\n\nShutting down dev environment..."));

  // Kill all child processes
  for (const child of children) {
    if (child.pid && !child.killed) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Process may already be dead
      }
    }
  }

  // Stop docker containers
  const stopSpinner = ora("Stopping Docker containers...").start();
  const result = await runCommand(
    "docker-compose",
    ["down"],
    root
  );
  if (result.code === 0) {
    stopSpinner.succeed("Docker containers stopped");
  } else {
    stopSpinner.warn("Docker containers may not have stopped cleanly");
  }

  console.log(chalk.green("Dev environment shut down."));
  process.exit(0);
}

export async function devCommand(): Promise<void> {
  let root: string;
  try {
    root = findMonorepoRoot(process.cwd());
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const authServiceDir = path.join(root, "packages", "auth-service");
  const dashboardDir = path.join(root, "packages", "dashboard");

  console.log(chalk.blue("\nStarting GTMShip local development environment\n"));
  console.log(chalk.gray(`  Monorepo root: ${root}\n`));

  // Register shutdown handlers
  process.on("SIGINT", () => shutdown(root));
  process.on("SIGTERM", () => shutdown(root));

  // ── Step 1: Start infrastructure (Postgres + Redis) ──────────────────

  const dockerSpinner = ora("Starting Docker containers (Postgres + Redis)...").start();
  const dockerResult = await runCommand(
    "docker-compose",
    ["up", "-d", "postgres", "redis"],
    root
  );
  if (dockerResult.code !== 0) {
    dockerSpinner.fail("Failed to start Docker containers");
    console.error(chalk.red(dockerResult.stderr));
    console.error(
      chalk.yellow(
        "Make sure Docker is running and docker-compose is installed."
      )
    );
    process.exit(1);
  }
  dockerSpinner.succeed("Docker containers running (Postgres + Redis)");

  // ── Step 2: Run Prisma migrations ────────────────────────────────────

  const prismaSpinner = ora("Running Prisma migrations...").start();
  const schemaPath = path.join(authServiceDir, "src", "prisma", "schema.prisma");
  const prismaResult = await runCommand(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", schemaPath],
    authServiceDir
  );
  if (prismaResult.code !== 0) {
    prismaSpinner.warn("Prisma migration had issues (DB may not be ready yet, will retry)");

    // Wait a few seconds for Postgres to be ready and retry once
    await new Promise((r) => setTimeout(r, 3000));

    const retryResult = await runCommand(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", schemaPath],
      authServiceDir
    );
    if (retryResult.code !== 0) {
      prismaSpinner.fail("Prisma migrations failed");
      console.error(chalk.red(retryResult.stderr));
      console.error(
        chalk.yellow(
          "You may need to run migrations manually: cd packages/auth-service && npx prisma migrate deploy"
        )
      );
      // Continue anyway -- the service might still work if migrations were already applied
    } else {
      prismaSpinner.succeed("Prisma migrations applied (after retry)");
    }
  } else {
    prismaSpinner.succeed("Prisma migrations applied");
  }

  // ── Step 3: Start dev servers ────────────────────────────────────────

  console.log(chalk.blue("\nStarting dev servers...\n"));

  const authPortAvailable = await isPortAvailable(4000);
  const dashboardPortAvailable = fs.existsSync(dashboardDir)
    ? await isPortAvailable(3000)
    : false;

  if (authPortAvailable) {
    spawnService(
      "npx",
      ["tsx", "watch", "src/server.ts"],
      authServiceDir,
      "auth",
      chalk.magenta
    );
  } else {
    console.log(
      chalk.yellow(
        "  Auth Service port 4000 is already in use. Reusing the existing service and skipping a new auth-service process."
      )
    );
  }

  if (fs.existsSync(dashboardDir)) {
    if (dashboardPortAvailable) {
      spawnService(
        "node",
        ["next-dev.js", "dev", "--port", "3000"],
        dashboardDir,
        "dashboard",
        chalk.cyan,
        { WATCHPACK_POLLING: "true" }
      );
    } else {
      console.log(
        chalk.yellow(
          "  Dashboard port 3000 is already in use. Reusing the existing service and skipping a new dashboard process."
        )
      );
    }
  } else {
    console.log(
      chalk.yellow(
        `  Skipping dashboard -- directory not found at ${dashboardDir}`
      )
    );
  }

  // ── Ready banner ─────────────────────────────────────────────────────

  console.log(
    chalk.green(`
  GTMShip dev environment is running!

  Dashboard:    http://localhost:3000${fs.existsSync(dashboardDir) && !dashboardPortAvailable ? " (existing process)" : ""}
  Auth Service: http://localhost:4000${!authPortAvailable ? " (existing process)" : ""}

  Press Ctrl+C to stop all services.
`)
  );
}
