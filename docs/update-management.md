# GTMShip Update Management

This document describes how GTMShip updates should be published, surfaced to users, and applied after release.

## Goals

- New GTMShip releases should become installable through Homebrew without manual user intervention beyond normal upgrade commands.
- Active users should be told when a newer version is available.
- Users who already upgraded the package but are still running the previous local runtime should be told to restart.
- The update experience should stay non-destructive and predictable. GTMShip should guide updates, not silently mutate the user's package manager state.

## Supported Update Channel

Today, the supported packaged install path is Homebrew:

```bash
brew install BalaMZPersonal/tap/gtmship
```

That means update handling is also Homebrew-first:

```bash
gtmship update --check
gtmship update
gtmship restart
```

`gtmship update` is the guided command for packaged installs.
`gtmship restart` is the runtime reload step when the package on disk is newer than the currently running dashboard/auth processes.

## Release Publisher Flow

The source of truth is the tag-driven GitHub Actions workflow in `.github/workflows/release-homebrew.yml`.

For each `v*` tag, the workflow should:

1. Build the macOS and Linux runtime tarballs.
2. Smoke-test each bundle.
3. Upload the tarballs to GitHub Releases.
4. Render `dist/homebrew/gtmship.rb`.
5. Render `dist/homebrew/gtmship-update.json`.
6. Push both files into `github.com/BalaMZPersonal/homebrew-tap`.

The important rule is:

- The formula and the update manifest must move together in the same tap update.

That prevents GTMShip from advertising a version that users cannot actually install yet.

## Update Metadata

The public update manifest lives in the tap repo as:

- `gtmship-update.json`

It should describe the newest installable version, not just the newest Git tag. The manifest currently carries:

- `version`
- `tag`
- `releasedAt`
- `notesUrl`
- `severity`
- `message`
- `minimumSupportedVersion`
- `recommendedCommand`

This manifest is what the product should read when deciding whether to show update messaging.

## User Experience Rules

### 1. New version available

If the latest published version is newer than the installed package version:

- show a dashboard banner
- show a short CLI notice after `gtmship open`, `gtmship start`, `gtmship restart`, and `gtmship status`
- recommend:

```bash
brew update && brew upgrade BalaMZPersonal/tap/gtmship
```

### 2. Package upgraded but runtime still old

If Homebrew has already upgraded GTMShip on disk, but the running dashboard/auth processes still report the previous version:

- do not keep telling the user to upgrade again
- instead tell them:

```bash
gtmship restart
```

This is the expected post-upgrade recovery path for the local runtime.

### 3. Non-Homebrew installs

If GTMShip cannot confirm that the install came from Homebrew:

- still allow `gtmship update --check`
- do not guess package-manager commands
- show release notes and manual guidance only

### 4. Network or metadata failures

If the manifest cannot be fetched:

- never block the CLI or dashboard
- mark the result as stale
- avoid destructive fallback behavior

## CLI Behavior

The CLI should support:

```bash
gtmship update --check
gtmship update
gtmship update --yes
```

Expected behavior:

- `--check` prints current, installed, latest, and whether restart is required.
- `gtmship update` runs the Homebrew upgrade flow for Homebrew installs.
- If the runtime was already running before upgrade, GTMShip should try to restart it automatically after a successful package upgrade.
- If restart fails, the package upgrade should still be considered complete and the user should be told to run `gtmship restart`.

## Dashboard Behavior

The dashboard should use a single global banner so every page gets the same update signal.

Banner actions should be lightweight:

- copy the recommended command
- open release notes
- snooze until tomorrow

The dashboard should not execute Homebrew commands directly.

## Snooze and Cache Policy

Update checks should be cached briefly so every page load does not hit the network.

Recommended behavior:

- cache the fetched manifest for a short TTL
- store snooze state keyed to the currently advertised latest version
- re-show the banner automatically when a newer version ships

## Operational Checklist For Each Release

Before tagging:

1. Confirm package versions are correct.
2. Run the relevant release build and smoke verification.
3. Confirm the new CLI/dashboard/auth runtime all report the intended version.

After tagging:

1. Watch the release workflow complete.
2. Confirm the GitHub release contains the tarballs.
3. Confirm the tap formula points at the new tarballs.
4. Confirm `gtmship-update.json` shows the same version as the formula.
5. Confirm `brew info BalaMZPersonal/tap/gtmship` resolves to the new version.

After publish:

1. Verify `gtmship update --check` sees the new version from an older install.
2. Verify the dashboard banner appears.
3. Verify `gtmship update` upgrades cleanly.
4. Verify `gtmship restart` clears any restart-required notice.

## What GTMShip Should Not Do

- Do not silently auto-upgrade in the background.
- Do not mutate Homebrew state from the dashboard.
- Do not advertise a release before the tap is updated.
- Do not require a restart when the installed and running versions already match.
- Do not block normal runtime usage just because update metadata is temporarily unavailable.

## Related Docs

- `docs/homebrew-release.md`
- `docs/cli-command-reference.md`
- `README.md`
