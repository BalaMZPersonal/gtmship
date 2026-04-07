import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { assertNoConflictingHealthyService } from "../dist/lib/local-runtime.js";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function waitForReady(url) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - startedAt > 5_000) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

test("assertNoConflictingHealthyService rejects a foreign healthy service", async () => {
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:http").createServer((req,res)=>res.end(JSON.stringify({status:"ok",service:"gtmship-auth"}))).listen(${port},"127.0.0.1")`,
    ],
    {
      stdio: "ignore",
    }
  );

  try {
    await waitForReady(`http://127.0.0.1:${port}/health`);
    await assert.rejects(
      () =>
        assertNoConflictingHealthyService({
          port,
          url: `http://127.0.0.1:${port}`,
          healthPath: "/health",
          matcher: (body) => body.includes('"service":"gtmship-auth"'),
          expectedEntrypoint: "/tmp/current-gtmship-auth.js",
          pidPath: path.join(os.tmpdir(), "gtmship-nonexistent-auth.pid"),
          serviceLabel: "A GTMShip auth service",
        }),
      /not the current GTMShip runtime/i
    );
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
  }
});

test("assertNoConflictingHealthyService accepts a healthy service running the expected entrypoint", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "gtmship-runtime-test-"));
  const entrypoint = path.join(tempDir, "expected-entry.mjs");
  const port = await reservePort();
  writeFileSync(
    entrypoint,
    `import http from "node:http";
http.createServer((req, res) => {
  res.end(JSON.stringify({ status: "ok", service: "gtmship-dashboard" }));
}).listen(${port}, "127.0.0.1");\n`,
    "utf8"
  );

  const child = spawn(process.execPath, [entrypoint], {
    stdio: "ignore",
  });

  try {
    await waitForReady(`http://127.0.0.1:${port}/api/health`);
    const result = await assertNoConflictingHealthyService({
      port,
      url: `http://127.0.0.1:${port}`,
      healthPath: "/api/health",
      matcher: (body) => body.includes('"service":"gtmship-dashboard"'),
      expectedEntrypoint: entrypoint,
      pidPath: path.join(os.tmpdir(), "gtmship-nonexistent-dashboard.pid"),
      serviceLabel: "A GTMShip dashboard",
    });
    assert.equal(result, "external");
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
