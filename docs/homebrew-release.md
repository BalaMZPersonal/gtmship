# Homebrew Release Flow

GTMShip ships to end users as a prebuilt macOS or Linux runtime bundle. Homebrew installs that bundle; it does not build the monorepo on the user's machine.

The Homebrew formula is also responsible for installing baseline runtime dependencies that GTMShip needs locally. In particular, brewed installs now pull in `pulumi` up front so cloud deploys do not fail later with a missing Pulumi CLI. The CLI still handles cloud-provider-specific helpers like `gcloud-cli`, Docker, and Colima at deploy time because those are only needed for certain workflows or providers.

In `github.com/BalaMZPersonal/gtmship`, pushing a `v*` tag is the intended publish flow. The `Release Homebrew` GitHub Actions workflow builds the release bundles, uploads the GitHub Release assets, renders `gtmship.rb`, renders `gtmship-update.json`, and updates `github.com/BalaMZPersonal/homebrew-tap` when the `HOMEBREW_TAP_TOKEN` repository secret is configured.

## Release Steps

1. Build release artifacts on matching host machines or CI runners:

   ```bash
   pnpm build:release -- --platform=darwin --arch=arm64
   pnpm build:release -- --platform=darwin --arch=x64
   pnpm build:release -- --platform=linux --arch=arm64
   pnpm build:release -- --platform=linux --arch=x64
   ```

   The build script refuses cross-platform packaging because the bundled runtime dependencies must match the host OS and CPU architecture.
   The GitHub Actions workflow also smoke-tests each built bundle before upload.

2. Upload the generated tarballs from `dist/homebrew/` to GitHub Releases, or let the tag-triggered GitHub Actions workflow do it for you.
3. Render a formula with every release URL and SHA256:

   ```bash
   pnpm render:homebrew-formula \
     --version 0.1.0 \
     --darwin-arm64-url <darwin-arm64-url> \
     --darwin-arm64-sha256 <darwin-arm64-sha256> \
     --darwin-x64-url <darwin-x64-url> \
     --darwin-x64-sha256 <darwin-x64-sha256> \
     --linux-arm64-url <linux-arm64-url> \
     --linux-arm64-sha256 <linux-arm64-sha256> \
     --linux-x64-url <linux-x64-url> \
     --linux-x64-sha256 <linux-x64-sha256>
   ```

4. Render the public update manifest:

   ```bash
   pnpm render:homebrew-update-manifest \
     --version 0.1.0 \
     --tag v0.1.0
   ```

5. Commit both `gtmship.rb` and `gtmship-update.json` into the tap repo.

## Tap Layout

- Main app repo: `github.com/BalaMZPersonal/gtmship`
- Homebrew tap repo: `github.com/BalaMZPersonal/homebrew-tap`
- Formula path in the tap repo: `Formula/gtmship.rb`
- Update manifest path in the tap repo: `gtmship-update.json`

## User Install Flow

```bash
brew install BalaMZPersonal/tap/gtmship
gtmship open
```

`gtmship open` starts the local Postgres cluster, auth service, and dashboard, then opens the browser to `http://localhost:3000`.

For cloud deploys:

- `pulumi` is installed as a Homebrew dependency of `gtmship`
- the CLI preflights `pulumi`, cloud credentials, enabled APIs, and other deploy prerequisites before it starts building artifacts
- the CLI auto-installs GCP-specific local helpers such as `gcloud-cli`, `docker`, and `colima` only when a workflow deploy actually needs them

On headless Linux machines or VMs, use:

```bash
gtmship start
gtmship status
```

To check for or apply updates later:

```bash
gtmship update --check
gtmship update
```

If the Homebrew package is newer than the running local runtime, use:

```bash
gtmship restart
```

- On macOS, `gtmship open` installs a LaunchAgent for login-time bootstrap.
- On Linux, `gtmship open` installs a `systemd --user` unit when `systemctl --user` is available.
