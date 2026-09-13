# macOS Desktop Helper

The desktop provider is a small native executable that implements MCP over stdio. It can therefore be
mounted by DevSpace or by another MCP host without adding a new public DevSpace tool.

## Build and register

```bash
npm run test:desktop-helper
DEVSPACE_DESKTOP_SIGNING_IDENTITY='<codesign identity>' \
  npm run build:desktop-host
sh scripts/install-desktop-host.sh
node scripts/doctor-desktop-host.mjs "$HOME/Applications/DevSpaceDesktopHost.app"
node scripts/doctor-desktop-host.mjs "$HOME/Applications/DevSpaceDesktopHost.app" --request-permissions
devspace providers add-desktop \
  --command "$HOME/Applications/DevSpaceDesktopHost.app/Contents/MacOS/devspace-desktop-helper"
```

Run `npm run test:desktop-lock-boundary` separately while macOS is locked; the
test must reject UI and lease operations.

After granting the two permissions to the installed signed Host, run
`npm run test:desktop-runtime-fixture` while unlocked. This is the production-path
acceptance test: it calls the fixed REST API through the dynamically mounted Provider
and installed Host, validates AX redaction, window screenshot, click, text and allowed
key input, restarts only the dedicated fixture app, and requires the old process-bound
lease to fail with `lease_expired` before a recovery lease succeeds. It refuses to run
while locked or while either production Host permission is absent.

The legacy helper script compiles a bare ad-hoc binary for fixture tests. The desktop-host build creates an
App Bundle with the fixed identifier `com.devspace.desktop-host`. Set
`DEVSPACE_DESKTOP_SIGNING_IDENTITY` to a stable Apple Development or Developer ID identity before installing
and granting TCC permissions; the default ad-hoc build is only for deterministic packaging tests. The
installer uses the fixed current-user path, verifies the signature, and moves an existing installation into
a timestamped backup instead of deleting it. `doctor-desktop-host.mjs` reports whether the installed bundle
has a valid, non-ad-hoc identity and silently probes the two TCC permissions. `--request-permissions` is the
only project-provided path that intentionally asks macOS to present the Accessibility and Screen Recording
authorization UI. Normal service start, Provider restart and health checks never request permissions.
Compatible upgrades must use the same team and identifier.

Permission doctor probes always launch the installed bundle through LaunchServices. Executing the Mach-O
directly from an already-authorized Terminal can inherit the terminal's TCC responsibility and produce a
false positive; that result is not accepted as evidence that the background App identity is authorized.

After updating the installed executable path, use `devspace.providers.control` through the fixed Capability
MCP or the REST admin action to reload the Provider without restarting DevSpace. Runtime permission truth is
reported separately by `devspace capabilities doctor --provider desktop.macos.accessibility --json`; a live
process can be `degraded` while its status capability remains available and protected capabilities report
`permission_required`.

Enable DevSpace capabilities and restart the service after registration. The Provider child is then kept
alive by the same supervisor used for Chrome and external MCP servers.

## Exposed capabilities

- `desktop.macos.status` reads Accessibility and Screen Capture preflight state.
- `desktop.macos.list_apps` lists regular running apps without window titles.
- `desktop.macos.list_windows` lists visible layer-zero windows for the exact leased process.
- `desktop.macos.snapshot_app` returns a depth/node/field-length bounded AX tree with a short-lived `snapshotId`
  and per-node `elementId`. Handles are process-bound, kept for at most 30 seconds and never persisted.
- `desktop.macos.screenshot_app` captures only the leased app's largest visible window, scales it to bounded dimensions, and returns PNG data plus source-frame/scale metadata.
- `desktop.macos.screenshot_window` captures an exact visible `windowId` owned by the leased process.
- `desktop.macos.activate_app` brings only the leased bundle to the foreground.
- `desktop.macos.click_point` clicks only while the leased process is frontmost and supports left/right and single/double click.
- `desktop.macos.click_element` prefers the public AXPress action for a current snapshot element and uses an in-window coordinate fallback only when required.
- `desktop.macos.focus_element` focuses a current snapshot element and verifies the resulting focus belongs to the leased process.
- `desktop.macos.scroll` posts bounded pixel scrolling only at a point inside a leased application window.
- `desktop.macos.drag` performs a bounded left-button drag whose start and end are both inside leased application windows.
- `desktop.macos.type_text` types only into a focused element owned by the leased app.
- `desktop.macos.press_key` accepts a bounded keyboard allowlist plus Command/Shift/Option/Control modifiers.

All operations except status and app listing require an `app_window` lease. The specialized Provider binds
the lease to both the app's `bundleId` and exact process ID, revalidates the process before every call, and
injects both values into the native Helper. The Helper repeats that validation at execution time and checks
the exact process—not merely another instance with the same bundle ID—is frontmost. An app restart therefore
expires the old lease instead of silently retargeting the new process. Argument attempts to replace either
identity are rejected. In the default delegated-
approval mode, mutation and secure-field input do not require a DevSpace Grant; the upper Agent approves
them. The Helper yields mutations while recent hardware input indicates that the local user is active, and
the Router rejects all desktop operations while the macOS session is locked.

Snapshot element handles are intentionally ephemeral. An expired snapshot, a restarted app or an element
owned by a different PID is rejected; clients take a fresh snapshot rather than replaying a stale semantic
action. This gives computer-use clients a semantic-first path while preserving bounded coordinate actions as
a fallback.

## DevSpace-owned login service

The repository includes its own macOS LaunchAgent installer so production startup does not need to be
implemented by a sibling application repository:

```bash
npm run install:macos-service -- --label com.devspace.$(id -u).7676
npm run doctor:macos-service -- --label com.devspace.$(id -u).7676
```

The installer copies the watchdog into `~/Library/Application Support/DevSpace/runtime`, writes a
`RunAtLoad` + `KeepAlive` LaunchAgent with `ProcessType=Standard`, keeps the bounded production resource
profile, and records `DEVSPACE_RELEASE_ID` / `DEVSPACE_SOURCE_COMMIT`. It does not place owner tokens,
tunnel keys or other secrets in the plist. Pass `--activate` only when an immediate service cutover is
intended; without it the launch configuration is safely staged for the next launch/restart.

`doctor:macos-service` checks launchd state, the DevSpace-owned supervisor path, `/healthz`, and whether the
running release matches the plist release. A release mismatch is reported as `restartRequired` rather than
silently claiming newly installed code is already running.

## Permissions and boundaries

Snapshot and input require macOS Accessibility permission for the exact helper binary. The helper reports a
generic MCP error which DevSpace maps to `permission_required` and `needs_user_action`; it never attempts to
click System Settings or bypass TCC. Application screenshots separately require Screen Recording permission.

The implementation intentionally does not expose whole-screen capture, arbitrary key chords,
secure-field values, clipboard access, login-window control, Touch ID or FileVault. It can type text supplied
by the approving Agent into the leased app's focused element, including a secure field, but never reads that
field's value.
App capture selects only an on-screen, layer-zero window owned by the leased app process and never falls back
to a whole-screen image. Its Screen Recording permission, bounded dimensions, and PNG signature are covered
by the fixture canary.

Lock-screen support is fail-closed: every AX and input capability declares `requiresUnlocked=true`. This
helper does not and must not attempt to unlock the Mac. Background protocol providers such as Chrome may be
relaxed only after their own versioned lock-screen soak passes.

`npm run test:desktop-lock-boundary` is the real locked-session acceptance path. It proves the helper remains
reachable for status while the Runtime rejects both a desktop capability call and an `app_window` lease
before any login-window interaction, and writes a redacted receipt under `.build/desktop-lock-boundary/`.
