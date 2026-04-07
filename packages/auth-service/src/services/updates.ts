import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prisma } from "./db.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { version: runningVersion } = require("../../package.json") as {
  version: string;
};

const DEFAULT_HOMEBREW_OWNER = process.env.GTMSHIP_HOMEBREW_OWNER?.trim() || "BalaMZPersonal";
const DEFAULT_FORMULA_REF = `${DEFAULT_HOMEBREW_OWNER}/tap/gtmship`;
const DEFAULT_MANIFEST_URL =
  process.env.GTMSHIP_UPDATE_MANIFEST_URL?.trim() ||
  `https://raw.githubusercontent.com/${DEFAULT_HOMEBREW_OWNER}/homebrew-tap/main/gtmship-update.json`;
const DEFAULT_RECOMMENDED_COMMAND = `brew update && brew upgrade ${DEFAULT_FORMULA_REF}`;
const MANIFEST_CACHE_SETTING_KEY = "gtmship_update_manifest_cache";
const NOTICE_STATE_SETTING_KEY = "gtmship_update_notice_state";
const UPDATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const UPDATE_FETCH_TIMEOUT_MS = 5_000;

type InstallMethod = "homebrew" | "unknown";

type UpdateManifest = {
  version: string;
  tag: string | null;
  releasedAt: string | null;
  notesUrl: string | null;
  severity: string;
  message: string | null;
  minimumSupportedVersion: string | null;
  recommendedCommand: string;
};

type ManifestCacheRecord = {
  checkedAt: string;
  manifest: UpdateManifest;
};

type UpdateNoticeState = {
  version: string;
  snoozedUntil: string | null;
};

export type UpdateStatus = {
  installMethod: InstallMethod;
  runningVersion: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  restartRequired: boolean;
  severity: string;
  message: string | null;
  notesUrl: string | null;
  recommendedCommand: string | null;
  checkedAt: string;
  stale: boolean;
  snoozedUntil: string | null;
};

type ManifestFetchResult = {
  manifest: UpdateManifest | null;
  checkedAt: string;
  stale: boolean;
};

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim();
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
}

function parseVersionSegments(version: string): number[] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }

  return match.slice(1).map((segment) => Number.parseInt(segment, 10));
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionSegments(left);
  const rightParts = parseVersionSegments(right);

  if (!leftParts || !rightParts) {
    return left.localeCompare(right, undefined, { numeric: true });
  }

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function chooseSeverity(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "info";
  }

  const normalized = value.trim().toLowerCase();
  return ["info", "warning", "critical"].includes(normalized)
    ? normalized
    : "info";
}

export function normalizeUpdateManifest(value: unknown): UpdateManifest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!version) {
    return null;
  }

  return {
    version,
    tag: typeof record.tag === "string" && record.tag.trim() ? record.tag.trim() : null,
    releasedAt: normalizeIsoTimestamp(record.releasedAt),
    notesUrl:
      typeof record.notesUrl === "string" && record.notesUrl.trim()
        ? record.notesUrl.trim()
        : null,
    severity: chooseSeverity(record.severity),
    message:
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : null,
    minimumSupportedVersion:
      typeof record.minimumSupportedVersion === "string" &&
      record.minimumSupportedVersion.trim()
        ? record.minimumSupportedVersion.trim()
        : null,
    recommendedCommand:
      typeof record.recommendedCommand === "string" &&
      record.recommendedCommand.trim()
        ? record.recommendedCommand.trim()
        : DEFAULT_RECOMMENDED_COMMAND,
  };
}

function buildUpdateMessage(input: {
  manifest: UpdateManifest | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  restartRequired: boolean;
}): string | null {
  if (input.restartRequired && input.installedVersion) {
    return `GTMShip ${input.installedVersion} is installed. Run \`gtmship restart\` to load the new runtime.`;
  }

  if (input.updateAvailable && input.manifest?.message) {
    return input.manifest.message;
  }

  if (input.updateAvailable && input.latestVersion) {
    return `GTMShip ${input.latestVersion} is available.`;
  }

  return null;
}

export function buildUpdateStatus(input: {
  installMethod: InstallMethod;
  runningVersion: string;
  installedVersion: string | null;
  manifest: UpdateManifest | null;
  checkedAt: string;
  stale: boolean;
  snoozedUntil: string | null;
}): UpdateStatus {
  const latestVersion = input.manifest?.version || null;
  const comparisonVersion = input.installedVersion || input.runningVersion;
  const updateAvailable = Boolean(
    latestVersion && compareVersions(latestVersion, comparisonVersion) > 0
  );
  const restartRequired = Boolean(
    input.installedVersion &&
      compareVersions(input.installedVersion, input.runningVersion) > 0
  );

  return {
    installMethod: input.installMethod,
    runningVersion: input.runningVersion,
    installedVersion: input.installedVersion,
    latestVersion,
    updateAvailable,
    restartRequired,
    severity: input.manifest?.severity || "info",
    message: buildUpdateMessage({
      manifest: input.manifest,
      installedVersion: input.installedVersion,
      latestVersion,
      updateAvailable,
      restartRequired,
    }),
    notesUrl: input.manifest?.notesUrl || null,
    recommendedCommand: restartRequired
      ? "gtmship restart"
      : updateAvailable && input.installMethod === "homebrew"
        ? input.manifest?.recommendedCommand || DEFAULT_RECOMMENDED_COMMAND
        : null,
    checkedAt: input.checkedAt,
    stale: input.stale,
    snoozedUntil: input.snoozedUntil,
  };
}

async function readSettingValue(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({
    where: { key },
  });
  return setting?.value || null;
}

async function writeSettingValue(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function readJsonSetting<T>(key: string): Promise<T | null> {
  const raw = await readSettingValue(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonSetting(key: string, value: unknown): Promise<void> {
  await writeSettingValue(key, JSON.stringify(value));
}

function resolveSnoozedUntil(
  noticeState: UpdateNoticeState | null,
  latestVersion: string | null
): string | null {
  if (!noticeState || !latestVersion || noticeState.version !== latestVersion) {
    return null;
  }

  const normalized = normalizeIsoTimestamp(noticeState.snoozedUntil);
  if (!normalized || Date.parse(normalized) <= Date.now()) {
    return null;
  }

  return normalized;
}

function findExecutable(name: string, extraDirs: string[] = []): string | null {
  const searchDirs = [
    ...extraDirs,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, name);
    try {
      accessSync(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // Ignore missing executables.
    }
  }

  return null;
}

function detectInstallMethod(): InstallMethod {
  const installRoot =
    process.env.GTMSHIP_INSTALL_ROOT?.trim() || fileURLToPath(import.meta.url);
  const normalized = installRoot.replace(/\\/g, "/");
  return normalized.includes("/Cellar/gtmship/") ? "homebrew" : "unknown";
}

async function runCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: UPDATE_FETCH_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getInstalledHomebrewVersion(): Promise<string | null> {
  const brew = findExecutable("brew", [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ]);
  if (!brew) {
    return null;
  }

  const raw = await runCommand(brew, ["info", "--json=v2", DEFAULT_FORMULA_REF]);
  if (!raw) {
    return null;
  }

  try {
    const data = JSON.parse(raw) as {
      formulae?: Array<{
        installed?: Array<{ version?: string }>;
      }>;
    };
    const installedVersions = (data.formulae?.[0]?.installed || [])
      .map((entry) => entry.version?.trim() || "")
      .filter(Boolean)
      .sort(compareVersions);
    return installedVersions.at(-1) || null;
  } catch {
    return null;
  }
}

async function fetchUpdateManifest(): Promise<UpdateManifest> {
  const response = await fetch(DEFAULT_MANIFEST_URL, {
    signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Update manifest request failed with ${response.status}.`);
  }

  const payload = normalizeUpdateManifest(await response.json());
  if (!payload) {
    throw new Error("Update manifest is invalid.");
  }

  return payload;
}

async function loadManifestCache(): Promise<ManifestCacheRecord | null> {
  const cached = await readJsonSetting<ManifestCacheRecord>(MANIFEST_CACHE_SETTING_KEY);
  if (!cached?.checkedAt || !normalizeUpdateManifest(cached.manifest)) {
    return null;
  }

  return {
    checkedAt: cached.checkedAt,
    manifest: normalizeUpdateManifest(cached.manifest) as UpdateManifest,
  };
}

async function loadUpdateManifest(): Promise<ManifestFetchResult> {
  const now = new Date().toISOString();
  const cached = await loadManifestCache();
  const cachedCheckedAt = cached?.checkedAt ? Date.parse(cached.checkedAt) : Number.NaN;

  if (
    cached &&
    Number.isFinite(cachedCheckedAt) &&
    Date.now() - cachedCheckedAt < UPDATE_CACHE_TTL_MS
  ) {
    return {
      manifest: cached.manifest,
      checkedAt: cached.checkedAt,
      stale: false,
    };
  }

  try {
    const manifest = await fetchUpdateManifest();
    const record: ManifestCacheRecord = {
      checkedAt: now,
      manifest,
    };
    await writeJsonSetting(MANIFEST_CACHE_SETTING_KEY, record);
    return {
      manifest,
      checkedAt: now,
      stale: false,
    };
  } catch {
    if (cached) {
      return {
        manifest: cached.manifest,
        checkedAt: cached.checkedAt,
        stale: true,
      };
    }

    return {
      manifest: null,
      checkedAt: now,
      stale: true,
    };
  }
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const installMethod = detectInstallMethod();
  const installedVersion =
    installMethod === "homebrew"
      ? await getInstalledHomebrewVersion()
      : runningVersion;
  const manifestResult = await loadUpdateManifest();
  const noticeState = await readJsonSetting<UpdateNoticeState>(NOTICE_STATE_SETTING_KEY);

  return buildUpdateStatus({
    installMethod,
    runningVersion,
    installedVersion,
    manifest: manifestResult.manifest,
    checkedAt: manifestResult.checkedAt,
    stale: manifestResult.stale,
    snoozedUntil: resolveSnoozedUntil(
      noticeState,
      manifestResult.manifest?.version || null
    ),
  });
}

export async function snoozeUpdateNotice(input: {
  version: string;
  until: string;
}): Promise<UpdateStatus> {
  const normalizedUntil = normalizeIsoTimestamp(input.until);
  if (!input.version.trim() || !normalizedUntil) {
    throw new Error("version and a valid until timestamp are required.");
  }

  await writeJsonSetting(NOTICE_STATE_SETTING_KEY, {
    version: input.version.trim(),
    snoozedUntil: normalizedUntil,
  } satisfies UpdateNoticeState);

  return getUpdateStatus();
}
