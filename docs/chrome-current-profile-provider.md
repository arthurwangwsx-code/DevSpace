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
  --command /absolute/path/to/chrome-devtools
```

命令在 `DEVSPACE_CAPABILITY_CONFIG_DIR`（默认 `~/.devspace/capabilities`）写入权限为
`0600` 的 Provider manifest，且不会覆盖同名文件。重启 DevSpace 并设置
`DEVSPACE_CAPABILITIES=1` 后生效。

预置通过官方 CLI 启动或复用默认用户级 daemon，参数为：

```text
start
--autoConnect
--no-category-extensions
--no-memory-debugging
--no-performance-crux
--no-usage-statistics
--redactNetworkHeaders
```

因此不会创建第二个 Chrome，也不会把 Extension、PWA、性能等额外工具隐式加入能力目录。
DevSpace 通过当前用户拥有的 Unix socket/Windows named pipe 直接调用该 daemon；daemon 内部只持有
一条 MCP stdio 长连接，并且在 DevSpace 重启、Provider reload 或一次请求结束后继续存活。CLI、CI
和 DevSpace 因而复用同一个 Chrome 调试连接，不会因为每个调用或每个 DevSpace 进程再触发一次
Chrome 确认。socket 会验证类型和当前用户 ownership，响应使用有界 NUL framing；页面调用按
downstream completion 串行，避免调用者超时后立即叠加第二个不可取消的 daemon 请求。

## Chrome 一次性用户动作

1. 在当前 Chrome 打开 `chrome://inspect/#remote-debugging` 并启用远程调试。
2. 首次建立连接时保持 macOS 登录、唤醒且解锁。
3. 首次调用页面能力时，Chrome 会显示“要允许远程调试吗？”。
4. 用户确认后重试调用。

DevSpace 不会点击、绕过或持久化这个安全确认。Chrome/系统重启或 Provider 重连后是否再次
询问由 Chrome 决定。Provider 在首次页面调用超时时会返回 `permission_required`，并进入
`needs_user_action`，而不是把原始下游异常泄漏给远端 Agent。

## 固定能力面

| Capability | 下游 tool | Lease | v1 运行条件 |
| --- | --- | --- | --- |
| `browser.chrome.list_pages` | `list_pages` | 无 | awake + logged-in |
| `browser.chrome.take_snapshot` | `take_snapshot` | `browser_page` | awake + logged-in |
| `browser.chrome.take_screenshot` | `take_screenshot` | `browser_page` | awake + logged-in |
| `browser.chrome.list_console_messages` | `list_console_messages` | `browser_page` | awake + logged-in |
| `browser.chrome.list_network_requests` | `list_network_requests` | `browser_page` | awake + logged-in |
| `browser.chrome.navigate` | `navigate_page` | `browser_page` | awake + logged-in |
| `browser.chrome.click` | `click` | `browser_page` | awake + logged-in |
| `browser.chrome.type_text` | `type_text` | `browser_page` | awake + logged-in |
| `browser.chrome.press_key` | `press_key` | `browser_page` | awake + logged-in |

`select_page` 仅供 Provider 在 lease 内部使用，不会出现在 Agent 可搜索/调用的目录里。所有页面
调用串行执行，并在调用前重新选择 lease 中的 `pageId`，避免共享 MCP 的隐式 selected-page
状态造成跨 Agent 串页。

Mutation 能力需要页面 lease，以保证每次调用重新选择同一 `pageId`。默认 delegated-approval
模式不要求 Grant，也不拦截密码框输入，是否调用由上层 Agent 审批。设置
`DEVSPACE_CAPABILITY_ENFORCE_POLICY=1` 后，才恢复 effect/target Grant 与 secure-field 拒绝策略。
v1 不暴露无法可靠关联 AX UID 与 DOM input type 的 `fill`。

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

OAuth 部署中默认只要求有效的 capability resource token；显式开启 enforced-policy 后，
发现端使用 `capabilities:discover`，调用和 lease 使用 `capabilities:invoke`，Grant 管理使用
`capabilities:admin`。CI 应通过
`DEVSPACE_CAPABILITY_BEARER_TOKEN` 注入短期 token；不得把 Chrome Cookie、URL query、
页面内容或 bearer token 写入 manifest 和日志。

若开启 enforced-policy，管理员可以给一个外部 Agent/CI 创建有期限的最小 Grant：

```bash
devspace grants add \
  --principal agent:browser-ci \
  --capability-pattern 'browser.chrome.*' \
  --provider-pattern browser.chrome.devtools \
  --effects readOnly,mutation,openWorld \
  --resource-type browser_page \
  --expires-at 2026-09-14T00:00:00Z
```

使用 `devspace grants list --json` 查询，使用 `devspace grants revoke <grant-id>` 撤销。
Grant 持久化在 DevSpace state database 中；创建、拒绝和撤销都会生成脱敏审计事件。

## 已知边界

- 当前 Profile 的 CDP 权限天然很大；显式 Catalog 映射控制稳定能力面，page lease 保证目标
  一致性，但二者不能降低下游进程本身对 Chrome 的权限。
- 上游 `chrome-devtools-mcp` 会初始化可见页面。冻结/异常页面、很多标签页或其他调试客户端
  可能导致 `list_pages` 超时。不要用增加无限超时掩盖问题。
- Chrome 是后台协议能力，DevSpace 不再添加 `requiresUnlocked` 本地限制；锁屏时是否成功由已经
  建立的 Chrome/CDP 连接决定。首次连接或重连仍可能需要解锁后确认。2026-09-13 的本机实测
  观察到：Codex Chrome 扩展通道在锁屏时仍能枚举 26 个当前 Profile 标签页，并能读取本地
  fixture 页的完整 AX 语义快照；在锁屏后新启的 `chrome-devtools-mcp` 1.9.0 daemon 能响应
  `status`，但 `list_pages` 在 60 秒内无响应。因此
  “锁屏前已建立的 daemon 连接能否持续 snapshot/click”仍必须在解锁后重新建连再锁屏验证，
  不能把 status 或扩展通道的结果当成 DevTools 通道通过。
- 页面 title/URL、DOM、截图、Console 和 Network 都可能含敏感信息；审批由上层 Agent 负责，
  结果不应进入普通请求日志。

## 诊断

```bash
chrome-devtools status
chrome-devtools list_pages --output-format=json
```

若 `list_pages` 超时，依次检查：Chrome 确认框、是否有第二个 MCP/CDP 客户端、冻结/异常标签页、
标签页数量和 `chrome://inspect` 中持续刷新的 Android/WebView target。修改 Chrome 设置或关闭
用户标签页前必须由用户决定。官方 daemon 在调用已跨 socket 后没有取消协议；超时只会终止
当前调用方等待。DevSpace 会阻止同一 Provider 立即叠加后续调用，但彻底恢复可能需要在解锁后
显式执行 `chrome-devtools start --autoConnect ...` 重建 daemon。
