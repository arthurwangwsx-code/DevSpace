# 参考工程：通用能力网关、浏览器 MCP 与电脑自动化

本目录保存经过筛选的第三方开源工程，用于设计 DevSpace 的通用
Capability Runtime。第三方源码是本机浅克隆的只读研究材料，不是 DevSpace
运行时依赖，也不纳入 DevSpace 主仓库提交。固定来源和提交见
[`sources.lock.json`](./sources.lock.json)，可用
`node 参考工程/sync-references.mjs` 在缺失时按固定提交恢复。

## 结论先行

参考实现共同支持一个两层设计：

1. **稳定的元能力层**负责搜索、列举、描述、启用、调用和审计能力。
2. **动态 Provider 层**接入 MCP、浏览器扩展、原生桌面 API、CLI 或远程 API。

DevSpace 不应为 Chrome、macOS UI、Windows UIA、设备控制分别创建一套外部
API。建议维护统一的 `CapabilityDescriptor` 和 `CapabilityProvider`，再通过
REST、MCP 和 CLI 三种适配器暴露同一个 Runtime。

## 已固定的参考快照

| 本地目录 | 上游工程 | 固定提交 | 许可证 | 主要参考价值 |
| --- | --- | --- | --- | --- |
| `docker-mcp-gateway` | `docker/mcp-gateway` | `a21c0ac1c1e7` | MIT | 动态 MCP、能力聚合、搜索、策略、长连接池 |
| `mcp-gateway-registry` | `agentic-community/mcp-gateway-registry` | `7c353798fa7d` | Apache-2.0 | 服务器、工具、Agent、Skill 的统一注册与语义搜索 |
| `mcp-registry` | `modelcontextprotocol/registry` | `739b70e8bc1b` | 许可证迁移中，见上游 `LICENSE` | 稳定版本 API、`server.json`、扩展命名空间 |
| `chrome-devtools-mcp` | `ChromeDevTools/chrome-devtools-mcp` | `d9a8cb6ec22a` | Apache-2.0 | 当前 Chrome、后台 daemon、Unix socket、工具调用 |
| `playwright-mcp` | `microsoft/playwright-mcp` | `8a13ef8e9f73` | Apache-2.0 | 当前浏览器扩展模式、持久 Profile、共享 Context |
| `qwen-open-computer-use` | `QwenLM/open-computer-use` | `f238d1bc85b5` | MIT | 跨平台语义 UI、快照句柄、权限引导、自动化测试 |
| `munim-computer-use` | `munimtechnologies/munim-computer-use` | `4cf64d0a6676` | Apache-2.0 | 原生 UI + 当前 Chrome、Native Messaging、后台输入 |
| `macos-mcp` | `CursorTouch/MacOS-MCP` | `a7e135c25092` | MIT | macOS AX、Screen Capture、launchd 常驻服务、HTTP MCP |

这些提交是 2026-09-13 的调研快照。后续更新必须先审阅上游差异，再修改
lock 文件；不要在参考工程中直接开发 DevSpace 功能。

## 一、能力网关与注册表

### Docker MCP Gateway：最接近目标架构

重点文件：

- [`pkg/gateway/dynamic_mcps.go`](./docker-mcp-gateway/pkg/gateway/dynamic_mcps.go)：固定的
  `mcp-find`、`mcp-add`、`mcp-config-set`、`mcp-remove`、`mcp-exec` 元工具。
- [`pkg/gateway/capabilitites.go`](./docker-mcp-gateway/pkg/gateway/capabilitites.go)：
  从多个下游 MCP 并发获取 tools、prompts、resources 和 templates，并包装 handler。
- [`pkg/gateway/findmcps.go`](./docker-mcp-gateway/pkg/gateway/findmcps.go)：BM25 搜索；名称、
  标题、标签、工具名和描述使用不同权重。
- [`pkg/gateway/mcpexec.go`](./docker-mcp-gateway/pkg/gateway/mcpexec.go)：按名称从内部
  registration map 找到工具，再用原始 JSON 参数调用。
- [`pkg/gateway/tool_policy.go`](./docker-mcp-gateway/pkg/gateway/tool_policy.go)：策略包装在
  handler 注册阶段，因此直接调用、`mcp-exec` 和组合调用不会绕过策略。
- [`pkg/gateway/clientpool.go`](./docker-mcp-gateway/pkg/gateway/clientpool.go)：缓存长期运行的
  下游 MCP client，区分远程 Server 与按需容器。
- [`pkg/gateway/reload.go`](./docker-mcp-gateway/pkg/gateway/reload.go)：重新拉取动态能力、过滤
  策略、检测命名冲突并替换 registration。

应借鉴：

- “固定元工具 + 动态 registration map”双轨调用方式。
- Provider 能力发现并行化。
- 工具名前缀和冲突检测。
- 在注册 handler 时统一包装策略、审计和遥测。
- 长连接池与失败后移除坏连接。

需要调整：Docker 实现有较强的会话级状态和容器假设；DevSpace 的浏览器与桌面
Provider 应是进程级常驻能力，并通过显式 lease/handle 区分调用者。

### MCP Gateway Registry：统一资产与语义搜索

重点文件：

- [`servers/mcpgw/models.py`](./mcp-gateway-registry/servers/mcpgw/models.py)：Server、Agent、
  Skill、ToolSearchResult 的结构化模型。
- [`servers/mcpgw/server.py`](./mcp-gateway-registry/servers/mcpgw/server.py)：固定
  `list_services`、`list_agents`、`list_skills`、`search_registry` 等 MCP 工具。
- [`api/openapi.json`](./mcp-gateway-registry/api/openapi.json)：注册、搜索、健康、审计、
  版本和连接配置的完整 HTTP API。

`search_registry` 用自然语言一次检索 MCP Server、工具、Agent、Skill 和 Virtual
Server，结果带工具 Schema、连接信息、相关分数，并可返回不含敏感参数和输出的
discovery receipt。这证明搜索对象不应只限于“工具”，而应统一为可发现的能力资产。

应借鉴：

- 一个搜索入口覆盖多种资产类型。
- 精确列表 API 与语义搜索 API 同时存在。
- discovery receipt 只记录候选、排名、限制和停止原因，不记录调用参数或结果。
- HTTP Registry 与 MCP Adapter 分离。

不应照搬：该工程面向企业多租户，包含 Keycloak、OpenSearch、Kubernetes 和大量管理
功能。DevSpace 第一阶段只需要本机 SQLite、文本/BM25 搜索和清晰的授权边界。

### 官方 MCP Registry：稳定核心与扩展 API

重点文件：

- [`docs/reference/api/openapi.yaml`](./mcp-registry/docs/reference/api/openapi.yaml)：版本化
  Registry HTTP API 和 JSON Schema。
- [`docs/reference/server-json/generic-server-json.md`](./mcp-registry/docs/reference/server-json/generic-server-json.md)：
  `server.json` 的包、远程传输、参数、环境变量和扩展元数据格式。
- [`docs/reference/api/extensions.md`](./mcp-registry/docs/reference/api/extensions.md)：用
  `/v0.1/x/<namespace>/<extension>` 隔离实验扩展，客户端必须容忍扩展缺失。

应借鉴：稳定核心 API 只做加法；实验字段放在反向域名命名的 `_meta` 或扩展命名空间；
发现结果携带版本、来源、传输和安装参数。它是“可安装 Provider 目录”，不是运行时
Capability Registry，二者不应混为一层。

## 二、浏览器 MCP

### Chrome DevTools MCP：Provider 常驻生命周期模板

重点文件：

- [`src/daemon/daemon.ts`](./chrome-devtools-mcp/src/daemon/daemon.ts)：daemon 启动一个真正的
  MCP client/stdio child，通过本机 Unix socket 或 Windows named pipe 接收短连接调用。
- [`src/daemon/client.ts`](./chrome-devtools-mcp/src/daemon/client.ts)：每次 CLI 调用连接 socket、
  发送工具名和参数、设置超时并断开。
- [`src/daemon/utils.ts`](./chrome-devtools-mcp/src/daemon/utils.ts)：PID/socket 路径和 session
  命名。
- [`docs/advanced-usage.md`](./chrome-devtools-mcp/docs/advanced-usage.md)：`--autoConnect` 连接
  用户已启动的 Chrome，首次需要 Chrome 明确授权。
- [`src/browser.ts`](./chrome-devtools-mcp/src/browser.ts)：读取 `DevToolsActivePort` 并通过
  Puppeteer 连接当前 Chrome。

特别值得借鉴的安全细节：daemon 检查 PID 目录属于当前用户且不可被 group/world 写入，
PID 文件使用 `O_NOFOLLOW` 和 `0600`，避免软链接替换；socket 只承担本机短请求，真正的
Chrome/MCP 状态留在常驻进程中。

DevSpace 可以将其作为第一种 `McpCapabilityProvider`，优先复用 daemon/CLI 协议验证，
后续再决定直接嵌入 MCP client 还是继续把 daemon 当 sidecar。

### Playwright MCP：当前用户浏览器与 Context 模式

重点文件：

- [`README.md`](./playwright-mcp/README.md)：`--extension` 连接用户现有 Chrome/Edge；
  `--shared-browser-context` 让 HTTP clients 共享 Context；另有 persistent profile 与
  isolated profile。
- [`index.js`](./playwright-mcp/index.js)：当前仓库只是 `playwright-core` 中实现的轻包装。

需要明确：本地 `playwright-mcp` 仓库没有完整核心实现，真正的连接和扩展代码位于
Microsoft Playwright 主仓库及 `playwright-core`。因此这里主要作为对外配置和行为
契约参考，不能误认为已经包含完整实现源码。

对于“当前正在使用的 Chrome”，Extension 模式比独立 persistent profile 更符合目标；
但需要设计标签页所有权，避免 Agent 无意控制用户未授权的其他标签页。

## 三、电脑自动化

### Qwen Open Computer Use：语义优先和快照作用域

重点文件：

- [`packages/OpenComputerUseKit/Sources/OpenComputerUseKit/MCPServer.swift`](./qwen-open-computer-use/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/MCPServer.swift)：
  macOS MCP 工具注册和调用。
- [`packages/OpenComputerUseKit/Sources/OpenComputerUseKit/AccessibilitySnapshot.swift`](./qwen-open-computer-use/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/AccessibilitySnapshot.swift)：
  Accessibility tree 和 element index。
- [`packages/OpenComputerUseKit/Sources/OpenComputerUseKit/Permissions.swift`](./qwen-open-computer-use/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/Permissions.swift)：
  权限检测。
- [`apps/OpenComputerUse/Sources/OpenComputerUse/PermissionOnboardingApp.swift`](./qwen-open-computer-use/apps/OpenComputerUse/Sources/OpenComputerUse/PermissionOnboardingApp.swift)：
  图形化权限引导。
- [`apps/OpenComputerUseLinux/main.go`](./qwen-open-computer-use/apps/OpenComputerUseLinux/main.go)：
  Linux MCP、CLI 调用和多调用序列；显式缓存 snapshot，动作必须引用最新元素。
- [`apps/OpenComputerUseSmokeSuite/Sources/OpenComputerUseSmokeSuite/main.swift`](./qwen-open-computer-use/apps/OpenComputerUseSmokeSuite/Sources/OpenComputerUseSmokeSuite/main.swift)：
  对真实 MCP `tools/list`、`tools/call` 和 UI fixture 做端到端检查。

应借鉴：Accessibility/语义节点优先，截图和坐标作为 fallback；动作使用快照作用域的
element id；不同平台保持同名、同 Schema 的核心能力；权限引导与后台 MCP 进程分开；
使用真实 fixture 测试点击、输入和拖拽。

### Munim Computer Use：桌面与当前 Chrome 的组合桥

重点文件：

- [`macos/Sources/BrowserBridge.swift`](./munim-computer-use/macos/Sources/BrowserBridge.swift)：
  Chrome Native Messaging host 与 MCP server 是两个不同生命周期的进程，中间使用
  user-private Unix socket 桥接。
- [`chrome-extension/background.js`](./munim-computer-use/chrome-extension/background.js)：
  每个 MCP client 独立拥有或显式接管标签页；持久化标签页 ownership；通过
  `chrome.debugger`/CDP 操作后台标签页。
- [`chrome-extension/manifest.json`](./munim-computer-use/chrome-extension/manifest.json)：扩展需要
  `tabs`、`debugger`、`nativeMessaging`、`scripting` 等高权限，应按此设计清晰的安装告知。
- [`macos/Sources/main.swift`](./munim-computer-use/macos/Sources/main.swift)：AXPress、Accessibility
  tree、ScreenCaptureKit、后台键鼠、secure-field 拒绝策略。
- [`windows-linux/src/tools.rs`](./munim-computer-use/windows-linux/src/tools.rs)：跨平台保持一致的
 工具 Schema。

应借鉴：当前用户 Chrome 的 Native Messaging 桥、每调用者标签页 ownership、用户标签页
adopt/release、密码字段默认拒绝、用户活跃时让出电脑、浏览器协议操作与桌面坐标操作分层。

风险：macOS 后台坐标输入部分使用非公开 SkyLight 符号，系统升级兼容性和发布审核风险较
高。DevSpace 第一版应优先使用公开 AX action、CGEvent 和浏览器 CDP，私有 API 只能作为
隔离且可关闭的实验 Provider。

### MacOS-MCP：常驻服务与权限边界参考

重点文件：

- [`src/macos_mcp/__main__.py`](./macos-mcp/src/macos_mcp/__main__.py)：FastMCP 工具、stdio/
  Streamable HTTP、无会话 HTTP 模式、launchd 安装和启动。
- [`src/macos_mcp/permissions.py`](./macos-mcp/src/macos_mcp/permissions.py)：Accessibility 和
  Screen Recording 检查。
- [`src/macos_mcp/ax`](./macos-mcp/src/macos_mcp/ax)：AX tree、窗口和元素操作。
- [`src/macos_mcp/infrastructure/security.py`](./macos-mcp/src/macos_mcp/infrastructure/security.py)：
  URL/SSRF 限制。

应借鉴：launchd 常驻、loopback 默认绑定、远程模式必须认证、锁屏/显示睡眠时截图失败要
明确降级、权限在启动前诊断。

不应照搬：它暴露通用 shell/osascript；对于统一 Capability Gateway，这类任意执行能力
不能与细粒度 UI 工具获得相同的默认信任级别。

## 建议形成的 DevSpace 核心模块

```text
CapabilityRuntime                  进程级生命周期
├── ProviderRegistry              Provider 注册、版本和配置
├── ProviderSupervisor            启停、健康、重连、退避
├── CapabilityCatalog             精确列表、Schema、标签和版本
├── CapabilitySearch              文本/BM25，未来可选 embedding
├── InvocationRouter              按 capabilityId 转发
├── LeaseManager                  显式 browser/app/device handle
├── PolicyEngine                  principal + capability + target + arguments
├── PermissionBroker              系统权限诊断与合法授权引导
└── AuditStore                    不记录 secret 的调用与发现回执
```

建议首版固定元工具：

```text
capability_list
capability_search
capability_describe
capability_invoke
capability_wait
provider_list
provider_status
permission_status
```

每个 Capability 至少描述：稳定 ID、版本、Provider、输入/输出 JSON Schema、风险影响、
所需权限、运行条件、是否需要 lease、超时和异步支持。高频且已授权的能力可以额外投影成
原生 MCP tool，但 Registry 始终是事实来源。

## 第一阶段参考优先级

1. 先读 Docker Gateway 的 `dynamic_mcps.go`、`capabilitites.go`、`tool_policy.go` 和
   `clientpool.go`，确定统一 Provider/Registry/Invocation 模型。
2. 结合官方 Registry 的稳定 API、版本和扩展规则定义 `CapabilityDescriptor`。
3. 用 Chrome DevTools MCP daemon 作为第一个 Provider，验证常驻、发现、调用和重连。
4. 用 Qwen 的 snapshot-scoped element 与真实 fixture 定义桌面 UI 的语义调用协议。
5. 用 Munim 的 Native Messaging 和标签页 ownership 验证“当前 Chrome”路径。
6. 最后再接入 macOS AX Provider；坐标操作、截图和任意脚本能力分级启用。

## 维护与合规

- 第三方源码保留各自 `LICENSE`、版权声明和 Git 历史来源。
- 当前目录不作为 vendor 目录；实现时优先学习结构并自行编写，不复制大段代码。
- 如果确实复用源码，必须逐文件核对许可证、NOTICE、修改声明和发布要求。
- 不在第三方 checkout 中运行未知安装脚本或授予系统权限。
- 更新参考快照前先检查工作树；同步脚本检测到提交不一致时会保留现场并失败，不覆盖修改。
