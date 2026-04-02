import { execFile } from "child_process";

const ALLOWED_COMMANDS = new Set([
  "curl",
  "python3",
  "python",
  "node",
  "jq",
  "rg",
  "grep",
  "sed",
  "head",
  "tail",
  "ls",
  "pwd",
  "base64",
  "echo",
  "cat",
  "pip3",
  "pip",
  "which",
  "env",
]);

const BLOCKED_PATH_PATTERNS = [
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /~?\/?\.ssh/,
  /~?\/?\.env/,
  /~?\/?\.aws/,
  /~?\/?\.gnupg/,
  /~?\/?\.npmrc/,
  /\/proc\//,
];

const MAX_TIMEOUT = 30_000;
const MAX_OUTPUT = 65_536;

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecutionOptions {
  cwd?: string;
}

function parseCommand(command: string): { exe: string; args: string[] } {
  // Simple shell-like parsing that handles quoted strings
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of command) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);

  const exe = tokens[0] || "";
  return { exe, args: tokens.slice(1) };
}

function containsBlockedPath(command: string): boolean {
  return BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(command));
}

function containsUnsafeFileReference(command: string): boolean {
  return command
    .split(/\s+/)
    .some(
      (token) =>
        (token.startsWith("/") && !/^https?:\/\//i.test(token)) ||
        token === ".." ||
        token.startsWith("../") ||
        token.includes("/../")
    );
}

function getInlineCodeArgument(exe: string, args: string[]): string | null {
  if (exe === "node") {
    const evalIndex = args.indexOf("-e");
    return evalIndex >= 0 && evalIndex + 1 < args.length
      ? args[evalIndex + 1]
      : null;
  }

  if (exe === "python" || exe === "python3") {
    const evalIndex = args.indexOf("-c");
    return evalIndex >= 0 && evalIndex + 1 < args.length
      ? args[evalIndex + 1]
      : null;
  }

  return null;
}

export async function executeCommand(
  command: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  if (containsBlockedPath(command)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Blocked: command references a restricted path.",
    };
  }

  const { exe, args } = parseCommand(command);

  if (!ALLOWED_COMMANDS.has(exe)) {
    return {
      exitCode: 1,
      stdout: "",
        stderr: `Command "${exe}" is not allowed. Allowed: ${Array.from(ALLOWED_COMMANDS).join(", ")}`,
      };
  }

  if (containsUnsafeFileReference(command)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "Blocked: absolute paths and parent-directory traversal are not allowed.",
    };
  }

  // For python/node inline code, validate it doesn't access blocked paths
  const inlineCode = getInlineCodeArgument(exe, args);
  if (inlineCode && containsBlockedPath(inlineCode)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Blocked: inline code references a restricted path.",
    };
  }

  if (inlineCode && containsUnsafeFileReference(inlineCode)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "Blocked: inline code references absolute paths or parent traversal.",
    };
  }

  return new Promise((resolve) => {
    const proc = execFile(
      exe,
      args,
      {
        cwd: options.cwd,
        timeout: MAX_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        env: {
          ...process.env,
          HOME: "/tmp",
          // Restrict HOME to tmp to limit file access
          TMPDIR: "/tmp",
        },
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          exitCode =
            error.code !== undefined
              ? typeof error.code === "number"
                ? error.code
                : 1
              : 1;
          if ("killed" in error && error.killed) {
            stderr += "\nProcess killed (timeout or memory limit).";
          }
        }

        resolve({
          exitCode,
          stdout: truncate(stdout, MAX_OUTPUT),
          stderr: truncate(stderr, MAX_OUTPUT),
        });
      }
    );

    // Safety: kill if not done after timeout + buffer
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, MAX_TIMEOUT + 5000);
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n... (output truncated)";
}
