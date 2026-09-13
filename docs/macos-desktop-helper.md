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
devspace providers add-desktop \
  --command "$HOME/Applications/DevSpaceDesktopHost.app/Contents/MacOS/devspace-desktop-helper"
```

Run `npm run test:desktop-lock-boundary` separately while macOS is locked; the
test must reject UI and lease operations.

The legacy helper script compiles a bare ad-hoc binary for fixture tests. The desktop-host build creates an
App Bundle with the fixed identifier `com.devspace.desktop-host`. Set
`DEVSPACE_DESKTOP_SIGNING_IDENTITY` to a stable Apple Development or Developer ID identity before installing
and granting TCC permissions; the default ad-hoc build is only for deterministic packaging tests. The
installer uses the fixed current-user path, verifies the signature, and moves an existing installation into
a timestamped backup instead of deleting it. `doctor-desktop-host.mjs` reports whether the installed bundle
has a valid, non-ad-hoc identity. Compatible upgrades must use the same team and identifier.

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
- `desktop.macos.snapshot_app` returns a depth/node/field-length bounded AX tree.
- `desktop.macos.screenshot_app` captures only the leased app's largest visible window, scales it to bounded dimensions, and returns PNG data.
- `desktop.macos.activate_app` brings only the leased bundle to the foreground.
- `desktop.macos.click_point` clicks only while the leased bundle is frontmost.
- `desktop.macos.type_text` types only into a focused element owned by the leased app.
- `desktop.macos.press_key` accepts only Return, Tab, Space, Delete, Escape and arrow keys.

All operations except status and app listing require an `app_window` lease. The specialized Provider binds
the lease to both the app's `bundleId` and exact process ID, revalidates the process before every call, and
injects both values into the native Helper. The Helper repeats that validation at execution time and checks
the exact process—not merely another instance with the same bundle ID—is frontmost. An app restart therefore
expires the old lease instead of silently retargeting the new process. Argument attempts to replace either
identity are rejected. In the default delegated-
approval mode, mutation and secure-field input do not require a DevSpace Grant; the upper Agent approves
them. The Helper yields mutations while recent hardware input indicates that the local user is active, and
the Router rejects all desktop operations while the macOS session is locked.

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
