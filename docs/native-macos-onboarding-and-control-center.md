# Native macOS Onboarding and Control Center

This document defines the product-facing macOS experience for installing and operating DevSpace on a new
Mac. It complements `distribution-and-control-center.md`: that document owns distribution/runtime mechanics;
this document owns the native UI, first-run flow, Browser setup, permission guidance, and steady-state
settings experience.

## Product principle

DevSpace is a single-instance product on one Mac. A user should not need to understand Node.js, Native
Messaging manifests, LaunchAgents, TCC databases, or provider process topology. The normal path is:

```text
download DevSpace.app
  -> open the native Setup Assistant
  -> choose workspace folders
  -> configure remote Tunnel
  -> set up Browser control
  -> grant requested macOS permissions
  -> enable Start at Login
  -> verify Ready
```

The native App is the primary product surface. The loopback Web Control Center and CLI remain supported as
fallback, diagnostics, development, and automation surfaces. All three surfaces call the same Node control
plane and persist the same `~/.devspace/config.json`; they must not implement parallel configuration logic.
An existing script/CLI installation is treated as migration state: the App preserves its configuration and
takes over the single service rather than creating a second profile or competing Browser/Desktop identity.

## Native UI architecture

`DevSpace.app` uses a native SwiftUI shell hosted by AppKit. The bundled Node runtime still starts the
loopback Control Center API, but the App no longer presents the Web UI as its primary window.

```text
SwiftUI DevSpace.app
  -> loopback Control Center API (Bearer token)
      -> shared config + installers + doctors + updater
          -> Core Service / Tunnel / Browser / Desktop Host
```

The main navigation is:

- **Overview** — readiness summary and common service actions.
- **Setup** — ordered first-run checklist and completion state.
- **Workspaces** — allowed root folders and local MCP port.
- **Tunnel** — friendly Tunnel ID / credential fields plus advanced command controls.
- **Browser** — bundled extension package, Native Host setup, Chrome installation guidance, doctor.
- **Permissions** — Accessibility, Screen Recording, optional Full Disk Access, doctor and System Settings links.
- **Startup** — login service state and controls.
- **Updates** — check/update/rollback using the shared Updater Core.
- **Diagnostics** — doctors plus an explicit link to the Web Control Center fallback.

The window uses native macOS sidebar/navigation, semantic colors, system materials, continuous rounded
rectangles, standard controls, SF Symbols, and automatic light/dark appearance. The menu-bar item remains a
compact operational surface for service state, Show DevSpace, start/restart/stop, refresh, and quit.

## First-run Setup Assistant

Setup is state-driven rather than a sequence of opaque installer buttons. Each step explains why it is needed,
what DevSpace can do after it is enabled, and which confirmation belongs to macOS/Chrome.

### 1. Workspace access

- Require at least one allowed workspace root.
- Use `NSOpenPanel` to add folders; users should not type paths for the common case.
- The allowlist remains the security boundary. Full Disk Access does **not** implicitly widen the allowlist.
- The GUI refuses to install/start the login service until at least one workspace root has been saved; first-run
  setup never falls back silently to a default project directory.

### 2. Remote Tunnel

The production App bundles a checksum-verified official `tunnel-client` under
`Contents/Resources/runtime/tunnel-client`. A clean Mac therefore does not need
to install the Tunnel runtime before first use. The GUI update action remains
available as an optional verified override for a newer Tunnel release.

The common Tunnel UI exposes:

- Enable managed Tunnel.
- Tunnel executable (auto-detected where possible).
- Tunnel ID.
- Runtime API key (entered through a native SecureField and persisted into DevSpace's `0600` secrets file),
  plus the resulting API-key file path for advanced/migration use.
- Public URL when known.
- Connect at DevSpace startup / restart on failure.

For the supported `tunnel-client` preset, DevSpace materializes the low-level arguments itself using the
configured values and `${localMcpUrl}`. Advanced users can switch to Custom and edit command/arguments/cwd.
Secrets should continue to be referenced through protected files rather than stored in the normal config.

The Tunnel page can also install or update OpenAI's official `tunnel-client` without Terminal. DevSpace
queries the official GitHub latest release, selects the macOS archive for the current CPU architecture,
downloads the release `SHA256SUMS.txt`, verifies the ZIP before extraction, and installs the binary under
`~/.local/bin/tunnel-client`. The executable field is populated from the verified install result. This keeps
the common migration flow to Tunnel ID + Runtime API key + Save/Restart, entirely inside the App.

### 3. Browser control

The release App must contain a complete installable Browser Bridge payload:

```text
DevSpace.app/Contents/Resources/devspace/releases/browser-extension-<version>/
  unpacked/
  devspace-browser-bridge-<version>.zip
  INSTALL.txt
  [optional CRX when a matching packaging key is available]
```

The **Set Up Browser** action performs every step Chrome permits DevSpace to automate:

1. install/update the Native Messaging Host;
2. reveal the bundled `unpacked` extension directory in Finder;
3. open `chrome://extensions` in Google Chrome;
4. show the exact remaining user-owned actions: enable Developer mode, choose **Load unpacked**, select the
   revealed folder;
5. run Browser Doctor after the user finishes.

DevSpace must not inject into Chrome profile preferences or auto-click Chrome's security UI. Chrome does not
provide a supported general-purpose API for silently installing an unpacked off-store extension. The product
therefore automates up to that security boundary and makes the remaining confirmation obvious and bounded.

## Permission guidance

Permissions are presented as product capabilities rather than implementation details.

### Computer Use permissions

The signed `DevSpaceDesktopHost.app` remains the stable TCC identity. The App provides separate rows for:

- **Accessibility** — required for semantic UI inspection and input control;
- **Screen Recording** — required for window/screen capture.

Each row has an explanation, **Open System Settings**, and **Check Again**. The existing Desktop Doctor is the
source of truth after the user grants access. DevSpace never edits the TCC database or clicks the system
permission confirmation on the user's behalf.

### Full Disk Access

Full Disk Access is optional and is only needed when the user's explicitly allowed workspace roots include
macOS privacy-protected locations. The GUI provides:

- an explanation that it does not bypass the DevSpace workspace allowlist;
- **Open Full Disk Access Settings**;
- a best-effort protected-path probe used as verification evidence.

Because macOS has no supported API that universally reports Full Disk Access state for every launch topology,
the UI must label the probe as **Verified / Not verified**, not as an authoritative TCC database query.

## Browser and permission APIs

The loopback Control Center owns the following shared actions so SwiftUI/Web/CLI behavior remains aligned:

- `browser.prepare`
- `browser.revealExtension`
- `browser.openExtensions`
- `browser.doctor`
- `desktop.install`
- `desktop.permissions`
- `desktop.doctor`
- `permissions.openAccessibility`
- `permissions.openScreenRecording`
- `permissions.openFullDiskAccess`
- `permissions.fullDiskAccessStatus`

Action failures use the existing bounded HTTP failure semantics. The native App displays human-readable
results and keeps raw diagnostics available in the Diagnostics page.

## Self-checking readiness

The onboarding UI is state-driven rather than a static checklist. DevSpace exposes a shared `setup.status`
action that evaluates workspace configuration, Browser readiness, Desktop Host permissions, login startup,
and any enabled Tunnel requirement. The native App runs this heavier readiness check at startup, after setup
actions, and when the user returns to DevSpace after Chrome/System Settings confirmation.

The five-second menu-bar health poll intentionally remains lightweight and does **not** launch Browser or
Desktop permission probes repeatedly. Overview and Setup render explicit blockers until the required checks
pass. Full Disk Access remains optional and is displayed separately because it is only needed when an allowed
workspace root falls under a macOS privacy-protected location.

## Packaging and portability gates

Every macOS release must verify that:

- the App embeds Node and the built DevSpace runtime;
- the App build refreshes the Node/TypeScript runtime by default so a stale `dist/` cannot be packaged beside a newer native shell;
- the Browser Bridge `unpacked` directory and ZIP exist inside the final App bundle;
- the Browser extension ID is stable and Native Host manifest pins the same ID;
- the bundled Desktop Host exists and passes `codesign --verify`;
- the native SwiftUI shell compiles for the release architecture;
- first-run actions never require a source checkout;
- Browser and permission guidance uses paths inside the installed App bundle or user-owned install locations,
  never paths from the build machine.
- the final DMG itself mounts, passes deep signature verification, cold-starts with a clean config directory,
  creates `auth.json` as `0600`, and can execute the Browser Native Host installer using only bundled files.

`package:macos-release` runs this DMG acceptance by default after producing the artifact. A build-only or
specialized environment may set `DEVSPACE_SKIP_RELEASE_DMG_ACCEPTANCE=1`, but a public GitHub Release must not
use that escape hatch as its final qualification.

## Definition of done

A new Mac is product-ready when a user can perform all routine setup without Terminal:

1. open DevSpace.app;
2. choose workspace folders;
3. enter Tunnel configuration and test/restart it;
4. click Set Up Browser, follow the bounded Chrome confirmation, then pass Browser Doctor;
5. install Desktop Host and grant Accessibility + Screen Recording from guided System Settings links;
6. optionally grant Full Disk Access and verify it when protected roots require it;
7. enable Start at Login;
8. see **Ready** in Overview and copy the local/public MCP endpoint;
9. update or roll back from the Updates page.

The Web Control Center remains usable if the native shell is unavailable, but it is no longer the visual
quality target for the product App.
