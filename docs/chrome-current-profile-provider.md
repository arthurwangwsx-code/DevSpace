# 当前 Chrome Provider

DevSpace 可以把官方 `chrome-devtools-mcp` 作为常驻下游 MCP 挂载，并通过固定的
`/capabilities/mcp`、REST 和 CLI 元接口暴露。该预置只连接用户已经运行的 Chrome，不启动
隔离 Profile。

## 安装与注册

```bash
npm install -g chrome-devtools-mcp@latest
devspace providers add-chrome
```

如果可执行文件不在 `PATH`：

```bash
devspace providers add-chrome \
  --command /absolute/path/to/chrome-devtools-mcp
```

命令在 `DEVSPACE_CAPABILITY_CONFIG_DIR`（默认 `~/.devspace/capabilities`）写入权限为
`0600` 的 Provider manifest，且不会覆盖同名文件。重启 DevSpace 并设置
`DEVSPACE_CAPABILITIES=1` 后生效。

预置的子进程参数为：

```text
--autoConnect
--no-category-extensions
--no-performance-crux
--no-usage-statistics
```

因此不会创建第二个 Chrome，也不会把 Extension、PWA、性能等额外工具隐式加入能力目录。
DevSpace 直接持有一条 MCP stdio 长连接，正常情况下不会为每次工具调用重启子进程。

## Chrome 一次性用户动作

1. 在当前 Chrome 打开 `chrome://inspect/#remote-debugging` 并启用远程调试。
2. 保持 macOS 登录、唤醒且解锁。
3. 首次调用页面能力时，Chrome 会显示“要允许远程调试吗？”。
4. 用户确认后重试调用。

DevSpace 不会点击、绕过或持久化这个安全确认。Chrome/系统重启或 Provider 重连后是否再次
询问由 Chrome 决定。Provider 在首次页面调用超时时会返回 `permission_required`，并进入
`needs_user_action`，而不是把原始下游异常泄漏给远端 Agent。

## 固定能力面

| Capability | 下游 tool | Lease | v1 运行条件 |
| --- | --- | --- | --- |
| `browser.chrome.list_pages` | `list_pages` | 无 | awake + logged-in + unlocked |
| `browser.chrome.take_snapshot` | `take_snapshot` | `browser_page` | awake + logged-in + unlocked |
| `browser.chrome.take_screenshot` | `take_screenshot` | `browser_page` | awake + logged-in + unlocked |
| `browser.chrome.list_console_messages` | `list_console_messages` | `browser_page` | awake + logged-in + unlocked |
| `browser.chrome.list_network_requests` | `list_network_requests` | `browser_page` | awake + logged-in + unlocked |

`select_page` 仅供 Provider 在 lease 内部使用，不会出现在 Agent 可搜索/调用的目录里。所有页面
调用串行执行，并在调用前重新选择 lease 中的 `pageId`，避免共享 MCP 的隐式 selected-page
状态造成跨 Agent 串页。

## CLI / CI 调用

```bash
devspace providers list --json
devspace capabilities search "Chrome snapshot" --json
devspace capabilities call browser.chrome.list_pages --arguments '{}' --json
devspace capabilities open browser.chrome.devtools \
  --type browser_page --selector '{"pageId":1}' --json
devspace capabilities call browser.chrome.take_snapshot \
  --lease '<leaseId>' --arguments '{}' --json
```

OAuth 部署中，发现端使用 `capabilities:discover`，调用和 lease 使用
`capabilities:invoke`。CI 应通过 `DEVSPACE_CAPABILITY_BEARER_TOKEN` 注入短期 token；不得把
Chrome Cookie、URL query、页面内容或 bearer token 写入 manifest 和日志。

## 已知边界

- 当前 Profile 的 CDP 权限天然很大；DevSpace 的 catalog allowlist 和 page lease 是外部 Agent
  的授权边界，但不能降低下游进程本身对 Chrome 的权限。
- 上游 `chrome-devtools-mcp` 会初始化可见页面。冻结/异常页面、很多标签页或其他调试客户端
  可能导致 `list_pages` 超时。不要用增加无限超时掩盖问题。
- 当前所有 Chrome 能力仍声明 `requiresUnlocked=true`。只有完成“解锁建立连接 -> 锁屏持续
  调用 -> 解锁后验证”的真实版本矩阵后，才允许对具体只读能力放宽。
- 页面 title/URL、DOM、截图、Console 和 Network 都可能含敏感信息；调用者必须具备明确的
  discover/invoke grant，结果不应进入普通请求日志。

## 诊断

```bash
chrome-devtools status
chrome-devtools list_pages --output-format=json
```

若 `list_pages` 超时，依次检查：Chrome 确认框、是否有第二个 MCP/CDP 客户端、冻结/异常标签页、
标签页数量和 `chrome://inspect` 中持续刷新的 Android/WebView target。修改 Chrome 设置或关闭
用户标签页前必须由用户决定。
