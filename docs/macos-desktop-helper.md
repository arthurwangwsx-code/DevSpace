# macOS Desktop Helper

The desktop provider is a small native executable that implements MCP over stdio. It can therefore be
mounted by DevSpace or by another MCP host without adding a new public DevSpace tool.

## Build and register

```bash
npm run test:desktop-helper
devspace providers add-desktop \
  --command "$PWD/.build/devspace-desktop-helper"
```

The build script compiles an optimized binary and applies an ad-hoc signature with the stable identifier
`com.devspace.desktop-helper`. Production packaging should replace this with a Developer ID signature and
keep the installed path and designated requirement stable before the user grants TCC permissions.

Enable DevSpace capabilities and restart the service after registration. The Provider child is then kept
alive by the same supervisor used for Chrome and external MCP servers.

## Exposed capabilities

- `desktop.macos.status` reads Accessibility and Screen Capture preflight state.
- `desktop.macos.list_apps` lists regular running apps without window titles.
- `desktop.macos.snapshot_app` returns a depth/node/field-length bounded AX tree.
- `desktop.macos.activate_app` brings only the leased bundle to the foreground.
- `desktop.macos.click_point` clicks only while the leased bundle is frontmost.
- `desktop.macos.type_text` types only into a verified non-secure focused element.
- `desktop.macos.press_key` accepts only Return, Tab, Space, Delete, Escape and arrow keys.

All operations except status and app listing require an `app_window` lease. The specialized Provider injects
the lease's `bundleId` and rejects argument attempts to target a different app. Mutation still requires an
explicit `mutation` grant. The Router rejects all desktop operations while the macOS session is locked.

## Permissions and boundaries

Snapshot and input require macOS Accessibility permission for the exact helper binary. The helper reports a
generic MCP error which DevSpace maps to `permission_required` and `needs_user_action`; it never attempts to
click System Settings or bypass TCC.

The first implementation intentionally does not expose whole-screen capture, arbitrary key chords, app
activation, secure-field values, clipboard access, login-window control, passwords, Touch ID or FileVault.
Screen capture remains a separate follow-up because an app-scoped capture needs a stable window selector and
real Screen Recording/TCC acceptance evidence.

Lock-screen support is fail-closed: every AX and input capability declares `requiresUnlocked=true`. This
helper does not and must not attempt to unlock the Mac. Background protocol providers such as Chrome may be
relaxed only after their own versioned lock-screen soak passes.
