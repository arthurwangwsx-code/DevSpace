# DevSpace Distribution, Control Center, and Tunnel Architecture

This document defines the productized installation and migration model for DevSpace. It is the canonical design for moving DevSpace to a new Mac, running it at login, configuring Browser and Computer Use, and managing a public MCP tunnel without depending on another repository.

## 1. Product goal

A fresh Mac should be able to install one `DevSpace.app`, complete setup in one Control Center, and reach a ready state without asking the user to understand Node.js, npm, LaunchAgents, Native Messaging manifests, Provider manifests, or TCC implementation details.

Development must remain equally first-class: a contributor can clone the repository and run DevSpace from scripts/CLI without replacing the installed production service. GUI and CLI must use the same persisted configuration and the same installers rather than maintaining parallel behavior.

## 2. Product surfaces

### 2.1 DevSpace.app

The product-facing macOS application is the Control Center. It owns onboarding and operations, not AI planning. Its responsibilities are:

- configure allowed workspace roots, port and public URL;
- configure a managed tunnel command and arguments;
- install/update the official OpenAI tunnel-client with release checksum verification for the common Tunnel preset;
- install/diagnose the Browser Native Messaging bridge;
- guide Chrome extension installation;
- install/diagnose the macOS Desktop Host and request TCC permissions explicitly;
- install/activate/diagnose the login service;
- display local/public MCP endpoints and health;
- later host update/rollback and release-channel controls.

The app embeds a known Node executable plus the DevSpace runtime. The Swift shell starts a loopback-only Control Center server and presents a native SwiftUI control surface over that shared API. The existing Web Control Center remains a fallback/debug surface rather than the primary product UI. Detailed onboarding and visual rules are defined in [`native-macos-onboarding-and-control-center.md`](native-macos-onboarding-and-control-center.md).

The macOS app also owns a menu-bar status item. The status item is intentionally operational rather than decorative: it shows whether the Core service is running and exposes **Show Control Center**, **Start Service**, **Restart Service**, **Stop Service**, **Refresh Status**, and **Quit DevSpace**. Closing the Control Center window does not implicitly stop the Core service.

### 2.2 DevSpace Core Service

The Core Service remains `devspace serve`. It owns Workspace MCP, Capability Runtime, Provider supervision, auth, persistence and the managed tunnel lifecycle. Production is launched by a DevSpace-owned LaunchAgent with `RunAtLoad` + `KeepAlive`.

### 2.3 Native Providers

Browser and desktop remain separate execution boundaries:

- Browser: Chrome Extension → Chrome Native Messaging Host → local Unix socket → Browser Provider.
- Deep Chrome debugging: DevSpace Provider → persistent chrome-devtools daemon.
- Computer Use: DevSpace Provider → stdio MCP → signed `DevSpaceDesktopHost.app`.

The user sees one product, while privileges and crashes remain isolated internally.

## 3. Unified configuration

GUI, CLI and login service read `~/.devspace/config.json`. Secrets remain separate from normal project files. The GUI must not invent a second database of settings.

DevSpace intentionally supports **one active product instance per macOS user**. App mode and script/CLI mode
share the same instance and configuration; installing `DevSpace.app` on a machine that previously ran the
source/CLI form is a takeover/upgrade path, not a second-instance path. The old script service must be stopped
before the App-owned login service is activated on the same port. Browser Native Messaging registration and
the Desktop Host remain machine/user-level shared components so Chrome setup and macOS TCC grants retain a
stable identity.

Tunnel configuration is a first-class section:

```json
{
  "allowedRoots": ["/Users/me/project"],
  "port": 7676,
  "tunnel": {
    "enabled": true,
    "autoStart": true,
    "command": "/absolute/path/to/tunnel-client",
    "args": [
      "run",
      "--mcp.server-url=${localMcpUrl}"
    ],
    "publicBaseUrl": "https://devspace.example.com",
    "restartOnExit": true
  }
}
```

The runtime injects `DEVSPACE_LOCAL_MCP_URL` and `DEVSPACE_PUBLIC_BASE_URL` into the tunnel process and also supports `${localMcpUrl}` / `${publicBaseUrl}` argument placeholders. Provider-specific credentials should use environment/file references rather than being committed to Git.

This command model intentionally does not hard-code Cloudflare, Tailscale, ngrok or the current OpenAI tunnel client. A user can switch tunnel implementations without changing DevSpace code.

## 4. Startup model

### Production

```text
macOS login
  -> DevSpace LaunchAgent
  -> service-supervisor
  -> bundled Node + devspace serve
       -> Workspace/Capability MCP
       -> Browser Provider
       -> Desktop Provider
       -> managed TunnelSupervisor (when configured)
```

The LaunchAgent must not overwrite the persisted public tunnel URL with localhost. Runtime config is the source of truth.

### Development

```text
git clone
  -> npm install
  -> npm run dev
```

Development can use a separate port/config directory when production is active. The source checkout must not need the App bundle to function.

## 5. First-run experience

The Control Center leads the user through these states:

1. **Core** — choose allowed roots and local port.
2. **Tunnel** — enable/disable managed tunnel, command, arguments and public URL.
3. **Browser** — install Native Host, reveal the extension bundled inside `DevSpace.app`, open Chrome extension page, follow the bounded Load Unpacked confirmation, run doctor.
4. **Computer Use** — install stable Desktop Host, guide Accessibility and Screen Recording authorization, optionally guide Full Disk Access for protected workspace roots, run doctor.
5. **Auto start** — install and activate the login service.
6. **Ready** — show local/public MCP URLs and client setup information.

System-owned confirmation steps remain explicit. DevSpace must not bypass macOS TCC or Chrome security prompts.

The native steady-state Control Center is organized into focused pages rather than one dense settings form:

1. **Overview** — readiness summary, local/public MCP endpoints and common service actions.
2. **Setup** — first-run checklist for workspace, Tunnel, Browser, Computer Use and startup.
3. **Workspaces** — explicit workspace allowlist and local MCP port.
4. **Tunnel** — friendly tunnel-client preset (Tunnel ID + credential file) or advanced custom command mode.
5. **Browser** — bundled Browser Bridge setup, Chrome guidance and Browser Doctor.
6. **Permissions** — Accessibility, Screen Recording, optional Full Disk Access and Desktop Host verification.
7. **Startup** — login service state and controls.
8. **Updates** — check, transactional update and rollback.
9. **Diagnostics** — doctors plus the Web Control Center fallback.

All normal product settings must be operable from the GUI. Terminal remains a development and automation interface, not a prerequisite for routine configuration. `Save & Restart Service` persists the same config used by the CLI and then activates the service through the shared service installer.

## 6. App packaging

`npm run build:control-center-app` creates `.build/DevSpace.app` with:

```text
DevSpace.app/
  Contents/MacOS/DevSpace              native SwiftUI/AppKit shell
  Contents/Resources/runtime/node      embedded Node executable
  Contents/Resources/devspace/         built DevSpace package/runtime
  Contents/Resources/devspace/releases/browser-extension-<version>/
                                        bundled Chrome bridge payload
  Contents/Resources/DevSpaceDesktopHost.app   optional prebuilt helper
```

Release packaging should use a stable Developer ID identity and notarization. Ad-hoc signing is acceptable only for local development validation. A release pipeline should build separate arm64/x64 artifacts or a validated universal distribution and verify native dependencies against the packaged architecture.

GitHub Releases should publish at least:

- `DevSpace-macOS-arm64-<version>.dmg` — drag-and-drop installer containing `DevSpace.app` and an `/Applications` shortcut;
- `DevSpace-macOS-arm64-<version>.zip` — automation-friendly archive of the App bundle;
- `SHA256SUMS.txt` — checksums for the distributed binary artifacts.

The Git tag, App version and package version must match. Public release notes must accurately describe the Apple trust state.

For frictionless installation on arbitrary Macs, the production release gate is:

1. sign the outer App, bundled Desktop Host and native executables with **Developer ID Application**;
2. create DMG/ZIP artifacts;
3. submit the distributable artifact using `xcrun notarytool`;
4. staple the notarization ticket where applicable;
5. verify with `codesign --verify --deep --strict` and `spctl --assess`;
6. upload only after the above checks succeed.

Apple Development / Apple Distribution identities do not replace Developer ID Application + notarization for zero-friction direct distribution. When a development release is intentionally published without Developer ID notarization, the GitHub Release must say so rather than claiming a Gatekeeper-clean install.

## 7. Migration to another Mac

Portable configuration consists of normal settings such as workspace conventions, tunnel command template and provider choices. Machine-specific absolute paths and credentials need to be re-resolved or entered on the destination machine. The Control Center should show unresolved paths instead of silently starting broken services.

Recommended migration flow:

```text
download/clone DevSpace
  -> open DevSpace.app or run devspace control-center
  -> review paths + tunnel config
  -> install Browser/Desktop components
  -> grant system permissions
  -> install login service
  -> run doctor + MCP canary
```

## 8. Safety boundaries

- Control Center listens only on loopback and requires an ephemeral bearer token.
- Managed tunnel is an explicit configured command; the Control Center does not expose arbitrary remote command execution.
- Desktop permissions remain attached to the stable signed Host.
- Tunnel credentials should be referenced from protected local files or environment sources.
- Service installation stages config before activation so an update cannot casually strand the remote connection.
- Control Center bootstrap tokens are removed from the address bar immediately after page load; API calls use
  `Authorization: Bearer` only. Control responses are `no-store` / `no-referrer` with a restrictive CSP.
- Persisted config and auth files are re-chmodded to `0600` on every write, including pre-existing files.
- Empty workspace allowlists are rejected by the Control Center rather than falling back to an implicit root.
- Child-process actions treat any non-zero exit as an operation failure and return bounded diagnostics.

## 9. Current implementation status

Implemented in the repository:

- unified `tunnel` configuration in `~/.devspace/config.json`;
- managed `TunnelSupervisor` lifecycle under `devspace serve`;
- public URL resolution from tunnel config;
- login-service installation that no longer forces the public URL back to localhost;
- loopback/token-protected Control Center backend and complete settings/status UI;
- native menu-bar service state with Start/Restart/Stop/Show/Quit shortcuts;
- Control Center actions for Browser Native Host, Chrome extension page, Browser doctor, Desktop Host install/permissions/doctor, service install/activate/doctor;
- `devspace control-center` CLI entry;
- native macOS `DevSpace.app` SwiftUI shell with embedded Node/runtime packaging and Web fallback;
- native first-run Setup Assistant for Workspaces, Tunnel, Browser, permissions and login startup;
- Browser setup action that installs the Native Host, reveals the bundled extension and opens Chrome's
  extensions page without bypassing Chrome's user confirmation boundary;
- guided Accessibility, Screen Recording and optional Full Disk Access settings with doctor/probe feedback;
- CLI/script development path remains available.
- release bootstrap `install.sh` plus machine-readable `release.json`;
- shared Updater Core for App install, GitHub release update, rollback and uninstall;
- Control Center `Updates` page over the same update manager;
- transactional previous-version retention under `~/.devspace/releases/`.

Release engineering still has separate optional/production responsibilities: Developer ID signing/notarization when desired, universal/dual-architecture release artifacts, scheduled background auto-update policy, and clean-machine release qualification.

## 10. Definition of done for a public release

A release is portable only when all of the following are proven on a clean Mac user account:

- DevSpace.app starts without a separately installed Node/npm runtime;
- Control Center can save config and install the login service;
- service survives logout/login and reports the same release identity;
- configured tunnel automatically reconnects and exposes the expected public MCP URL;
- Browser doctor passes after the documented Chrome user action;
- Desktop doctor passes after explicit macOS permission grants;
- local and public MCP canaries pass;
- upgrade preserves config/auth and TCC identity;
- rollback restores the previous runnable release;
- uninstall removes service/runtime registrations without deleting user projects.

The repository also runs a bounded final-artifact gate (`npm run test:macos-release-dmg`) that mounts the
generated DMG, verifies the App signature/version, cold-starts it with an isolated config directory, checks
owner-auth file permissions, and exercises the Browser Native Host installer directly from the mounted App.

## 11. Script installation and transactional updates

Every release publishes `install.sh`, `release.json`, `SHA256SUMS.txt`, and the architecture-specific App
archives. `install.sh` is intentionally a thin bootstrap: it resolves the latest GitHub tag, selects the host
architecture, downloads the ZIP and checksum file, verifies SHA-256, extracts the App, then invokes the
**Updater Core inside the downloaded DevSpace runtime**. Installation policy therefore does not live in shell.

The shared update surface is:

```text
install.sh                    first install / repeatable bootstrap update
devspace install              transactional App placement used by bootstrap
devspace update --check       inspect latest release manifest
devspace update               download, verify and install latest release
devspace rollback             restore the retained previous App
devspace uninstall            remove App + login service, preserve ~/.devspace
Control Center > Updates      GUI over the same update manager
```

Normal installation targets `~/Applications/DevSpace.app`, avoiding an administrator-password requirement.
Users may still drag the DMG App into `/Applications`; when DevSpace is running from an App bundle the updater
uses that bundle path as its default target.

Update transaction:

```text
fetch release.json
  -> choose darwin-arm64 / darwin-x64 artifact
  -> download ZIP
  -> verify SHA-256
  -> codesign --verify staged DevSpace.app
  -> move existing App into ~/.devspace/releases/<version>/
  -> place the staged App at the stable target
  -> rewrite/restart the login service when already installed
  -> record ~/.devspace/update-state.json
```

Rollback uses `update-state.json` and the retained App backup. Configuration, owner credentials, workspace
state and user projects are deliberately outside the App bundle and are not replaced by an upgrade. The
uninstaller preserves `~/.devspace` unless the explicit `--purge-config` option is supplied.

`release.json` is the machine-readable update contract (`schemaVersion: 1`). New release metadata should be
added compatibly; incompatible manifest changes require a schema-version increment and updater compatibility
window rather than silently changing field meaning.
