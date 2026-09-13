# DevSpace 通用能力运行时落地方案

> 文档状态：实施基线（Draft for Implementation）
>
> 编写日期：2026-09-13
>
> 适用仓库：`/Users/ai/project/ai-tools/devspace`
> 目标读者：负责后续落地的工程 Agent、代码审阅者和本机管理员

## 1. 结论与实施决策

DevSpace 下一阶段应新增一个**进程级通用能力运行时**（Capability Runtime），把浏览器
MCP、桌面自动化、设备控制或其他外部能力统一注册为 `Capability`。外部调用方只面对一组
稳定的发现、搜索、描述、租约、调用、状态和取消接口；新增 Provider 或工具时，只改变内部
Catalog 数据，不改变外部 API 形状。

本方案作出以下约束性决策：

1. 现有 `/mcp`、现有工具名、输入输出和 workspace 生命周期保持不变。
2. 新能力通过独立的 `/capabilities/mcp` 和 `/api/capabilities/v1` 暴露，不能动态修改
   现有 MCP Server 的 tool list。
3. v1 只暴露固定元工具，不把每个动态能力投影成顶层 MCP tool；这样 MCP 客户端缓存
   `tools/list` 时，新增 Provider 也不会导致契约漂移。
4. `CapabilityRegistry` 是 REST、MCP 和 CLI 的唯一事实来源；三个入口调用同一个
   `CapabilityRuntime`，不能各自实现一套行为。
5. Provider 是进程级常驻对象，调用者通过短期 `lease` 使用浏览器页面、App、窗口或设备；
   不把整个 Provider 生命周期绑定到某个 HTTP/MCP 会话。
6. Provider 安装、注册、启用由已认证的上层审批 Agent 通过固定管理 API 或 Catalog 管理能力
   完成。默认 delegated-approval 不叠加 Grant、逐 executable/来源/secure-field/动作审批；
   `capabilities:admin` 与 Grant 仅在显式开启 enforced-policy 兼容模式时生效。
7. OS 权限和 DevSpace 授权是两层边界。DevSpace 可以保持已授权进程和 refresh token，
   但不能绕过 Chrome 首次连接确认、macOS TCC、用户登录和锁屏边界。
8. 第一种 Provider 是当前用户 Chrome 的 Chrome DevTools MCP；第二种 Provider 是基于
   macOS Accessibility/ScreenCaptureKit 的桌面自动化 Helper。

这一设计吸收了本仓库 [`参考工程`](../参考工程/README.md) 中 Docker MCP Gateway 的
“固定元工具 + 动态 registration”、官方 MCP Registry 的稳定版本 API、Chrome DevTools
MCP 的常驻进程、Munim 的标签页所有权，以及 Qwen Open Computer Use 的快照作用域元素。

## 2. 目标、非目标与不变量

### 2.1 本期目标

- Agent 能精确列出、搜索和描述本机已批准的能力及 JSON Schema。
- REST、MCP 和 CLI 都能调用同一项能力并得到一致的结果与错误。
- Chrome Provider 能连接用户当前正在使用的 Chrome，而不是创建隔离 Profile。
- Chrome/桌面 Provider 可以常驻、健康检查、自动重连、退避和优雅关闭。
- 能力调用有 principal、策略、目标租约、并发、超时、取消、审计和输出大小限制。
- 首次权限申请由用户在解锁的图形会话中完成，后续合法复用，不反复请求同一权限。
- 锁屏时只运行经过验证且不依赖前台 UI 的能力，并明确报告降级原因。
- 后续 Agent 可以按本文的批次逐步实现、测试和提交，而不需要重新做架构判断。

### 2.2 明确非目标

- 不把 `exec_command` 当作日常能力网关。
- 不在 v1 做第三方 Provider 商店、在线安装、自动升级或依赖解析。
- 不在 v1 做 embedding/向量数据库；先用确定性的过滤和 BM25。
- 不在 v1 实现 Windows UIA 和 Linux AT-SPI，但公共 Schema 必须给它们留出空间。
- 不使用 macOS 私有 SkyLight API；不把通用 shell、JXA 或 AppleScript 暴露为默认 UI 能力。
- 不承诺桌面 UI 在登录窗口、FileVault 解锁前或用户会话不存在时可操作。
- 不用一次“构建通过”替代真实 Chrome、权限、锁屏和恢复路径的验收。

### 2.3 必须持续成立的不变量

| 不变量 | 验证方式 |
| --- | --- |
| 现有 `/mcp` API 无变化 | 改造前后保存 `tools/list` fixture 并做结构化 diff |
| 既有 workspace 行为无变化 | 运行现有单测、集成测试和 workspace 恢复测试 |
| 动态能力不绕过策略 | 所有调用只允许经过 `InvocationRouter`，Provider handler 不直接外露 |
| Provider 不获得隐式任意执行 | 只允许管理员配置的 executable + argv，不经过 shell |
| secret 不进 Catalog、日志和审计 | 测试 env/header/password/secure-field 的脱敏 fixture |
| 一个调用者不能误用另一个调用者的页面/窗口 | lease 绑定 principal，并在路由层强制校验 |
| 服务重启不伪造旧目标有效性 | Provider Catalog 可恢复，live lease 不恢复，必须重新选择目标 |
| 锁屏不尝试解锁或输入密码 | 策略硬拒绝，错误为 `temporarily_unavailable` 或 `policy_denied` |

## 3. 总体架构

```text
                         DevSpace 单一服务进程

现有 MCP 客户端 ───────> /mcp ───────────────> 既有 Workspace/Process 工具
                                                    （保持原样）

外部 Agent/MCP 客户端 ─> /capabilities/mcp ─┐
REST/CI/脚本 ──────────> /api/capabilities/v1 ├─> CapabilityRuntime
本机管理员 CLI ────────> devspace capabilities ┘      │
                                                         ├─ Registry + Search
                                                         ├─ Policy + Permission
                                                         ├─ Lease + Invocation
                                                         ├─ Audit + Events
                                                         └─ ProviderSupervisor
                                                               │
                         ┌─────────────────────────────────────┼──────────────┐
                         │                                     │              │
                  Chrome DevTools MCP                   macOS Helper      Future Provider
                  当前 Chrome / CDP                    AX / Capture      Device/API/MCP
```

`CapabilityRuntime` 在 `createServer()` 时创建一次，和 workspace store、process session
manager 处于同一级生命周期。每个 `/capabilities/mcp` 会话只保存传输层状态和 principal，
不会重复启动 Chrome 或桌面 Helper。

### 3.1 术语

| 术语 | 含义 |
| --- | --- |
| Provider | 能发现并执行一组能力的适配器，如 Chrome DevTools MCP |
| Capability | 具有稳定 ID、Schema、风险、权限和运行条件的可调用动作 |
| Descriptor | Capability 的只读描述，Catalog 中的基本记录 |
| Catalog Revision | 每次能力集合变化后递增的版本号，供客户端增量刷新 |
| Principal | 经过认证的调用主体；通常由 OAuth client、resource 和本机身份组成 |
| Grant | principal 可以对哪些 capability/target/effect 做什么的授权规则 |
| Lease | principal 对短期目标（page/window/device）的带过期时间引用 |
| Invocation | 一次可追踪、可取消、有超时和状态的能力调用 |
| Permission | Chrome/OS/辅助进程真实需要的权限状态，不等同于 DevSpace Grant |

## 4. 外部 API：固定接口、动态数据

### 4.1 REST 路径

REST 根路径固定为 `/api/capabilities/v1`。v1 内只允许向响应增加可选字段；删除字段、
改名或改变语义必须发布 v2。

| 方法 | 路径 | 用途 | 最小 Scope |
| --- | --- | --- | --- |
| `GET` | `/providers` | 列出 Provider 及健康状态 | `capabilities:discover` |
| `GET` | `/providers/:providerId` | Provider 详情、权限和诊断 | `capabilities:discover` |
| `GET` | `/capabilities` | 精确过滤、分页列举能力 | `capabilities:discover` |
| `POST` | `/capabilities/search` | 按自然语言和过滤条件搜索 | `capabilities:discover` |
| `GET` | `/capabilities/:capabilityId` | 获取完整 Descriptor/Schema | `capabilities:discover` |
| `POST` | `/leases` | 为 page/window/device 建立租约 | `capabilities:invoke` |
| `DELETE` | `/leases/:leaseId` | 主动释放租约 | `capabilities:invoke` |
| `POST` | `/invocations` | 同步等待或创建异步调用 | `capabilities:invoke` |
| `GET` | `/invocations/:invocationId` | 查询调用状态和结果 | `capabilities:invoke` |
| `POST` | `/invocations/:invocationId/cancel` | 尽力取消调用 | `capabilities:invoke` |
| `GET` | `/permissions` | 查询 Provider 权限和解锁要求 | `capabilities:discover` |
| `GET` | `/events` | SSE：Catalog/Provider/Invocation 状态变化 | `capabilities:discover` |

Provider 动态管理进入固定的管理员控制面：`GET/POST /admin/providers`、
`POST /admin/providers/:id/actions` 和 `DELETE /admin/providers/:id`。同一能力也作为
`devspace.providers.*` Catalog 条目，通过既有 `capability_invoke` 使用；因此安装新 MCP
不会改变固定八个 MCP 元工具。默认只验证调用者已认证，审批责任由上层 Agent 承担；显式开启
enforced-policy 兼容模式后才要求 `capabilities:admin`。

### 4.2 通用响应和错误

成功响应：

```json
{
  "data": {},
  "meta": {
    "requestId": "req_01...",
    "catalogRevision": 12
  }
}
```

失败响应：

```json
{
  "error": {
    "code": "permission_required",
    "message": "Chrome requires approval from an unlocked user session.",
    "retryable": false,
    "details": {
      "providerId": "browser.control",
      "action": "Approve the connection prompt in Chrome"
    }
  },
  "meta": {
    "requestId": "req_01..."
  }
}
```

固定错误码：

- `capability_not_found`
- `provider_unavailable`
- `permission_required`
- `temporarily_unavailable`
- `invalid_arguments`
- `policy_denied`
- `lease_required`
- `lease_expired`
- `timeout`
- `cancelled`
- `conflict`
- `rate_limited`
- `output_too_large`
- `internal_error`

HTTP status 与错误码一一映射；Provider 的原始异常不能直接透传给客户端，必须归一化并
保留在脱敏诊断日志中。

### 4.3 列表和搜索示例

```http
GET /api/capabilities/v1/capabilities?providerId=browser.control&tag=snapshot&limit=20
```

```json
{
  "data": {
    "items": [
      {
        "id": "browser.page.snapshot",
        "version": "2.0.0",
        "title": "读取页面可访问性快照",
        "description": "读取所选 Chrome 页面中可交互元素的语义快照。",
        "providerId": "browser.control",
        "tags": ["browser", "page", "snapshot"],
        "effects": { "readOnly": true, "destructive": false, "openWorld": true },
        "availability": { "state": "ready" }
      }
    ],
    "nextCursor": null
  },
  "meta": { "requestId": "req_01...", "catalogRevision": 12 }
}
```

搜索请求：

```json
{
  "query": "读取当前 Chrome 页面上可点击的按钮",
  "filters": {
    "providerIds": ["browser.control"],
    "effects": ["readOnly"],
    "availableOnly": true
  },
  "limit": 10
}
```

搜索只返回调用者有权发现的结果。默认不返回不可用或未授权能力；诊断主体可显式指定
`includeUnavailable`，但仍不能查看 secret 配置。

### 4.4 Lease 示例

```json
POST /api/capabilities/v1/leases
{
  "providerId": "browser.control",
  "resourceType": "browser_page",
  "selector": {
    "pageId": 1
  },
  "ttlSeconds": 900
}
```

```json
{
  "data": {
    "leaseId": "lease_01...",
    "providerId": "browser.control",
    "resourceType": "browser_page",
    "display": { "title": "DevSpace", "urlOrigin": "https://example.test" },
    "expiresAt": "2026-09-13T10:15:00Z"
  },
  "meta": { "requestId": "req_01...", "catalogRevision": 12 }
}
```

返回值不暴露可伪造的底层 CDP session。`leaseId` 是随机不可预测的 server-side handle，
只能由创建它的 principal 使用。页面关闭、导航导致目标失效、Provider 重启或 TTL 到期时，
调用返回 `lease_expired`；客户端必须重新列举并选择目标。

### 4.5 Invocation 示例

```json
POST /api/capabilities/v1/invocations
{
  "capabilityId": "browser.page.snapshot",
  "leaseId": "lease_01...",
  "arguments": { "verbose": false },
  "mode": "sync",
  "timeoutMs": 30000,
  "idempotencyKey": "1c251bf8-..."
}
```

同步调用在上限内直接返回：

```json
{
  "data": {
    "invocationId": "inv_01...",
    "status": "succeeded",
    "result": { "content": [] },
    "startedAt": "2026-09-13T10:00:00Z",
    "finishedAt": "2026-09-13T10:00:01Z"
  },
  "meta": { "requestId": "req_01...", "catalogRevision": 12 }
}
```

若调用耗时较长或 `mode=async`，返回 `202` 和 `queued/running` 状态。幂等键只对同一
principal、capability 和规范化参数摘要生效；参数不同但复用同一 key 返回 `conflict`。

### 4.6 固定 MCP 元工具

`/capabilities/mcp` 始终只注册以下工具：

| MCP 工具 | 对应功能 |
| --- | --- |
| `capability_list` | 精确列举和过滤 |
| `capability_search` | 文本搜索能力 |
| `capability_describe` | 读取完整输入/输出 Schema、权限和风险 |
| `capability_open` | 创建目标 lease |
| `capability_invoke` | 调用能力，可选择同步/异步 |
| `capability_status` | 查询 invocation/provider/permission 状态 |
| `capability_cancel` | 取消 invocation |
| `capability_close` | 释放 lease |

MCP adapter 只做协议转换、Schema 校验和 principal 注入，不实现业务逻辑。所有工具最终
调用 `CapabilityRuntime`。MCP 结果内容需同时提供短文本摘要和结构化 JSON，避免模型只能
解析日志字符串。

不实现“每个 Capability 都变成一个 MCP tool”，也不另建按领域或 profile 扩张的 MCP
endpoint。未来若确实需要改变一级协议，必须作为显式架构版本变更处理，不能绕过固定八工具
契约。

### 4.7 本机 CLI

```text
devspace capabilities list [--provider ID] [--tag TAG] [--json]
devspace capabilities search <query> [--json]
devspace capabilities describe <capability-id> [--json]
devspace capabilities open <provider-id> --type TYPE --selector JSON [--json]
devspace capabilities call <capability-id> [--lease ID] --arguments JSON [--json]
devspace capabilities status [invocation-id] [--json]
devspace capabilities cancel <invocation-id>
devspace capabilities close <lease-id>
devspace capabilities doctor [--provider ID] [--json]

devspace providers list [--json]
devspace providers add-mcp --manifest <absolute-path>
devspace providers enable <provider-id>
devspace providers disable <provider-id>
devspace providers restart <provider-id>
```

调用类 CLI 应优先连接正在运行的 DevSpace 本机 control socket/loopback API，保证和远程
调用共享同一个 Runtime。Provider 管理调用默认只验证调用者已认证，具体审批由上层 Agent
负责；落盘配置仍必须校验本机目录 ownership 和文件权限，防止其他 OS 用户篡改运行时配置。

## 5. 核心数据模型

### 5.1 CapabilityDescriptor

建议在 `src/capabilities/types.ts` 定义领域类型，在
`src/capabilities/descriptor-schema.ts` 使用 Zod 定义运行时 Schema，并从 Zod 生成 JSON
Schema，避免 TypeScript 和对外 Schema 分叉。

```ts
interface CapabilityDescriptor {
  id: string;                    // 稳定 ID，如 browser.page.snapshot
  version: string;               // Descriptor/行为的 semver
  providerId: string;            // 稳定 Provider ID
  title: string;
  description: string;
  tags: string[];
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effects: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;          // 是否可访问网页、网络或外部系统
  };
  permissions: Array<{
    id: string;                  // chrome.connection / macos.accessibility 等
    required: boolean;
    description: string;
  }>;
  availability: {
    requiresAwake: boolean;
    requiresLoggedInSession: boolean;
    requiresUnlocked: boolean;
    requiresForegroundApp: boolean;
  };
  execution: {
    modes: Array<"sync" | "async">;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    requiresLease: boolean;
    resourceTypes: string[];
  };
  metadata?: Record<string, JsonValue>; // 仅限安全、可序列化、命名空间化扩展
}
```

命名规则：

- Capability ID 使用 `<domain>.<resource>.<action>`，全局小写，段只允许 `[a-z0-9_-]`。
- 公共 Provider ID 描述稳定路由域，例如 `browser.control`；实现型 Provider ID（如
  `browser.chrome.devtools`）只用于内部 backend、诊断和迁移。
- 底层 MCP 的原始 tool name 只放在 Provider 私有 binding 中，不作为外部稳定 ID。
- 语义不兼容时发布新 Capability ID 或 major version；不能静默修改旧 Schema。
- `metadata` 扩展键使用反向域名或项目 namespace，客户端必须容忍未知字段。

### 5.2 Provider 状态

```text
disabled
stopped
starting
ready
degraded
needs_user_action
backoff
failed
stopping
```

每个状态都携带 `since`、安全的 `reasonCode`、`retryAt` 和可选 `userAction`。启动时遇到
Chrome 授权提示不能让整个 DevSpace 启动失败，应进入 `needs_user_action`；用户授权后自动
或经管理员 `restart` 恢复。

### 5.3 Provider SPI

```ts
interface CapabilityProvider {
  readonly id: string;
  start(context: ProviderContext): Promise<void>;
  stop(reason: string): Promise<void>;
  health(signal: AbortSignal): Promise<ProviderHealth>;
  discover(signal: AbortSignal): Promise<DiscoveredCapability[]>;
  open(request: OpenResourceRequest, context: InvocationContext): Promise<ProviderLease>;
  invoke(request: ProviderInvocation, context: InvocationContext): Promise<JsonValue>;
  cancel?(providerInvocationId: string): Promise<void>;
  close?(providerLease: ProviderLease, context: InvocationContext): Promise<void>;
}
```

`ProviderContext` 只提供受限日志、事件发布、secret resolver、临时目录和 AbortSignal；不把
整个 server config、数据库连接或任意 shell helper 交给 Provider。

`DiscoveredCapability` 包含 Descriptor 和私有 binding。Catalog 保存 Descriptor，binding
仅留在内存 Registry 中。Provider 重启后必须重新 discover，Catalog revision 递增。

### 5.4 Catalog 与搜索

v1 搜索采用 SQLite FTS5 或进程内 BM25；字段权重建议参考 Docker MCP Gateway：

```text
capability id / provider id       4
title / exact tags                3
原始 tool name / aliases          2
description                       1
```

排序再叠加确定性因素：exact ID、权限、ready 状态、只读优先和版本。任何基于权限不可见的
Capability 必须在进入搜索索引结果前过滤，不能先返回再拒绝。向量/embedding 作为后续独立
实验，不影响精确列表和固定 ID 调用。

## 6. 模块与文件布局

建议新增以下结构；单个文件保持单一职责：

```text
src/capabilities/
├── types.ts
├── errors.ts
├── descriptor-schema.ts
├── registry.ts
├── search.ts
├── provider.ts
├── provider-supervisor.ts
├── runtime.ts
├── router.ts
├── leases.ts
├── policy.ts
├── permission-broker.ts
├── audit-store.ts
├── http-router.ts
├── mcp-server.ts
├── config.ts
├── redaction.ts
└── providers/
    ├── mcp-client-provider.ts
    └── chrome-devtools-provider.ts

src/cli/
├── capabilities.ts
└── providers.ts

test/capabilities/
├── descriptor-schema.test.ts
├── registry.test.ts
├── search.test.ts
├── policy.test.ts
├── leases.test.ts
├── provider-supervisor.test.ts
├── runtime.test.ts
├── http-router.test.ts
├── mcp-server.test.ts
├── fake-provider.ts
└── chrome-devtools-provider.integration.test.ts
```

若仓库现有测试目录或 CLI 目录命名不同，实施者应遵循现有布局，但领域边界不能合回
`src/server.ts`。`server.ts` 只负责创建 Runtime、挂载 router/server 和关闭资源。

## 7. 配置、Provider Manifest 与持久化

### 7.1 Feature flag 和资源配置

第一阶段默认关闭，直到兼容性和真实路径验收通过：

```text
DEVSPACE_CAPABILITIES=0|1
DEVSPACE_CAPABILITY_CONFIG_DIR=<absolute path>
DEVSPACE_CAPABILITY_MAX_CONCURRENT=8
DEVSPACE_CAPABILITY_MAX_CONCURRENT_PER_PROVIDER=2
DEVSPACE_CAPABILITY_QUEUE_LIMIT=64
DEVSPACE_CAPABILITY_MAX_OUTPUT_BYTES=4194304
DEVSPACE_CAPABILITY_DEFAULT_TIMEOUT_MS=30000
DEVSPACE_CAPABILITY_MAX_TIMEOUT_MS=120000
DEVSPACE_CAPABILITY_MAX_TRACKED_INVOCATIONS=10000
DEVSPACE_CAPABILITY_INVOCATION_RETENTION_MS=86400000
DEVSPACE_CAPABILITY_RESTART_MAX_DELAY_MS=60000
```

不要使用 env 开关直接接受拼接后的 shell 字符串。可执行文件、参数和环境变量引用放进
Agent 提交的 Manifest；配置加载时校验结构、绝对路径、文件 ownership 和权限。

### 7.2 Provider Manifest

默认目录建议为 `~/.devspace/capabilities/providers/*.json`，目录 `0700`、文件 `0600`。
示例：

```json
{
  "schemaVersion": 1,
  "id": "browser.chrome.devtools",
  "kind": "mcp-stdio",
  "enabled": false,
  "command": "/absolute/path/to/chrome-devtools-mcp",
  "args": ["--autoConnect"],
  "environment": {
    "allow": ["PATH", "TMPDIR"],
    "secrets": {}
  },
  "lifecycle": {
    "autostart": true,
    "restart": "on-failure",
    "startupTimeoutMs": 30000,
    "healthIntervalMs": 15000
  },
  "policyProfile": "chrome-current-user"
}
```

安全要求：

- 使用 `spawn(command, args, { shell: false })`，禁止 `sh -c`。
- `command` 必须是绝对路径并以 `shell=false` 启动；DevSpace 不维护 executable 目录白名单。
- `envFrom` 明确映射子进程变量到服务进程中的变量；DevSpace 不做变量名审批，责任由上层 Agent 承担。
- Provider stdout 作为协议流，不进入普通日志；stderr 逐行限长、限速并脱敏。
- Manifest 变化先完整校验，再原子替换 Runtime 配置；失败时保留最后一个有效版本。
- 已认证 Agent 可经固定管理 API 提交、启停、重载或移除 Manifest；变更需要审计且原子持久化。

### 7.3 SQLite 迁移

在现有迁移之后新增单独版本（以实施时的最新版本号为准），建议表：

```text
capability_providers
  provider_id PK, kind, enabled, manifest_digest, state, last_seen_at,
  last_error_code, created_at, updated_at

capability_descriptors
  capability_id PK, version, provider_id, descriptor_json, descriptor_digest,
  catalog_revision, discovered_at, retired_at

capability_grants
  grant_id PK, principal_id, capability_pattern, provider_pattern,
  resource_type, target_constraint_json, allowed_effects_json,
  expires_at, created_by, created_at, revoked_at

capability_invocations
  invocation_id PK, principal_id, capability_id, provider_id, lease_id,
  status, arguments_digest, result_digest, error_code,
  queued_at, started_at, finished_at, expires_at

capability_audit_events
  event_id PK, request_id, principal_id, event_type, capability_id,
  provider_id, decision, redacted_summary_json, created_at
```

不持久化 live Provider binding、CDP session、AX element 引用或 lease 内部对象。lease 默认
只存在内存，重启即失效。Invocation 表不保存原始参数和原始结果，只保存摘要、digest、状态
与错误码；若未来需要结果暂存，必须加独立加密存储、TTL 和大小上限。

## 8. Runtime 生命周期和故障恢复

### 8.1 与现有 Server 集成

实施时按以下顺序接入：

1. `createServer()` 读取并校验 capability config。
2. 在创建每个 MCP session 之前构造一个进程级 `CapabilityRuntime`。
3. Runtime 初始化数据库、Registry、Policy、Lease、Router、Audit 和 Supervisor。
4. feature flag 开启后异步启动 enabled Providers；Provider 失败不阻塞现有 `/mcp`。
5. 为 `/capabilities/mcp` 的每个连接创建轻量协议 adapter，并注入共享 Runtime。
6. 挂载 REST router 和 SSE；沿用现有 request id、日志和关闭信号。
7. 关闭时先停止接收新 invocation，取消/等待有界时间，再停止 Provider，最后关闭数据库和日志。

不得把 Runtime 创建放进现有 per-session `createMcpServer()`，否则每个 MCP 会话都会启动一套
Chrome/Helper 进程。建议把现有 MCP server factory 保持不变，新增独立
`createCapabilityMcpServer(runtime, principal)`。

### 8.2 Supervisor

Supervisor 负责：

- 单实例启动锁，防止同一 Provider 重复进程。
- startup/health/discover 超时。
- 指数退避 + jitter，最大延迟 60 秒。
- 连续失败阈值和 circuit breaker。
- 子进程退出、协议错误、Catalog 变化和权限状态事件。
- 优雅停止后再强制终止；不得留下孤儿进程。
- `needs_user_action` 不自动高频重试，等待权限事件或低频诊断。

建议退避：`min(1000 * 2^attempt, maxDelay) + random(0, 250)`；5 次连续启动失败后进入
`failed`，管理员 restart 或配置变化后清零。运行超过稳定窗口（如 5 分钟）再失败，attempt
重新从 0 计算。

### 8.3 Catalog 刷新

Provider ready 后 discover；能力集合按 `(providerId, capabilityId, version, digest)` 原子更新。
若新集合有重复 ID、非法 Schema 或越权 effect，整个 Provider 的新 Catalog 不生效，旧的
已知 Catalog 标记 stale，Provider 进入 degraded。成功刷新才递增全局 revision 并发布事件。

## 9. 认证、授权、策略与审计

### 9.1 OAuth Resource 隔离

现有 `/mcp` resource 和 token audience 保持不变。新 endpoint 使用独立 canonical resource，
例如：

```text
https://<devspace-host>/capabilities/mcp
```

推荐扩展现有单用户 OAuth provider，使其显式支持一组已配置 resource audience，并在每条
route 上验证 token 的 exact audience 和 scope。若现有 provider 的结构不适合多 resource，
则创建共享同一 OAuth store 的第二个 provider；不能把 `/mcp` token 无条件复用于能力入口。

Scope 语义：

- 默认 delegated-approval 模式：token 只用于认证，不以 scope/Grant 做二次审批。
- enforced-policy 兼容模式：`capabilities:discover` 用于发现，`capabilities:invoke` 用于调用，
  `capabilities:admin` 用于动态 Provider 与 Grant 管理。

获得 refresh token 后，客户端可以合法续期 DevSpace 授权，不需要每次 API 调用都请求用户。
这解决的是 DevSpace 认证，不会替代 Chrome 或 macOS 的系统授权。

本机 CLI 可以使用 loopback/control socket principal，但只在请求来自当前用户拥有的 socket
或严格 loopback 时启用；远程请求不能伪装成本机 principal。

### 9.2 审批委托与可选 Grant 兼容模式

默认模式只执行身份认证、Schema、lease ownership、运行条件、并发/配额、超时、输出限制和审计；
不检查 capability/provider/effect/target Grant，也不拦截 secure-field 参数。上层 Agent 是审批点。

只有设置 `DEVSPACE_CAPABILITY_ENFORCE_POLICY=1` 时，才在 Router 中加入下列旧策略阶段：

一次调用必须按固定顺序经过：

```text
认证 principal
  -> capability 是否可见
  -> Provider/权限/运行条件是否满足
  -> 输入 JSON Schema
  -> lease ownership/target
  -> Grant 与 effect/argument policy
  -> 并发、配额、幂等和超时
  -> Provider invoke
  -> 输出 Schema、大小限制和脱敏
  -> 审计结果
```

策略规则至少支持：

- principal/resource/scope
- capability/provider glob
- effect（readOnly/destructive/openWorld）
- resource type 和 target constraint（domain、App bundle id、设备 ID）
- argument constraint（导航域名 allowlist、文件路径 allowlist 等）
- 有效期、创建人、撤销时间

enforced-policy 模式 fail closed；delegated-approval 是本项目默认值。旧策略能力包括：

- 已认证主体可发现经过管理员启用的安全摘要。
- Chrome 的 `list_pages`、`take_snapshot` 可在显式页面 lease 后授予只读调用。
- 导航、点击、输入、上传、下载等 mutation 需要单独 grant。
- password/secure field 默认永久拒绝远程填写；只能由明确的高信任本机策略例外。
- 任意 shell、任意 AppleScript、解锁、密码输入和安全设置修改不注册为 Capability。

策略必须包装在 Router 层，不能只放在 REST/MCP adapter 中，否则 CLI 或组合调用可能绕过。

### 9.3 审计与脱敏

记录：谁在什么时间发现/调用了什么能力、Provider、target 摘要、策略决定、耗时、状态和
错误码。不要记录：OAuth token、Cookie、Authorization/header、密码、完整网页文本、截图、
原始输入/输出或 Provider 完整 stderr。

建议事件名：

```text
capability.catalog.refreshed
capability.provider.state_changed
capability.permission.changed
capability.lease.opened
capability.lease.closed
capability.invocation.queued
capability.invocation.started
capability.invocation.succeeded
capability.invocation.failed
capability.invocation.cancelled
capability.policy.denied
```

## 10. 通用外部 MCP Provider

DevSpace 必须像 Codex/Claude 等 MCP Host 一样挂载外部 MCP Server，并把下游 tools 自动发现
或显式映射进统一 Catalog，再通过固定 REST/MCP/CLI 元接口暴露。这不是 Chrome 特例，而是
所有 MCP Provider 的基础适配层。

首版支持两种传输：

```text
mcp-stdio
  command: 绝对可执行路径
  args: 字符串数组
  env: explicit envFrom mapping

mcp-streamable-http
  url: 固定 https/受控 loopback URL
  headers: secret reference
  oauth: 后续增加独立凭据代理，不复用 DevSpace client token
```

`McpClientProvider` 持有长期 MCP Client/Transport，启动后执行 `initialize` 和 `tools/list`。
`discoverAllTools=true` 时，每个下游 tool 自动生成稳定 Capability ID；显式 `tools` 映射可为
选定工具覆盖 ID、版本和描述性 effect/availability 元数据。原始 tool name、inputSchema、
annotations 和 server/version 只作为 binding/metadata。`tools/list_changed` 通知触发原子
rediscover 和 Catalog revision，不能直接修改正在执行的 registration map。

若初始化能力声明包含 `resources` 或 `prompts`，Provider 自动增加 resources list/templates/read
和 prompts list/get 五项动态 Capability。它们沿用固定 invoke、超时、取消、输出限制和审计链，
不会增加外层工具；server instructions 只作为不可信连接元数据，不能进入 Agent 指令上下文。

自动 ID 为 `<provider-id>.<normalized-tool-name>`，归一化冲突时追加稳定 hash；Manifest 的
`discoveredToolVersion` 控制全部自动描述符版本。不同 Provider 的同名 tool 不冲突；同一稳定
ID 被另一 Provider 占用时整次刷新失败。上游 Schema digest 改变后刷新失败，管理员需要提高
`discoveredToolVersion` 或增加显式版本映射，不能静默扩大参数契约。

安全要求：

- stdio 只允许 `shell=false` 的绝对 executable + argv，继承最小 env。
- HTTP 默认只允许 HTTPS；loopback 例外必须显式配置。解析后的 IP、redirect 和 DNS rebinding
  都要受 SSRF 策略约束。
- 下游 Server instructions、description、tool result 和 resource 内容全部视为不可信数据，
  不能成为 DevSpace 管理指令。
- MCP annotations 只是风险提示，最终 readOnly/destructive/openWorld 和权限由本地 Manifest
  mapping 决定。
- 已认证的上层 Agent 可以注册、启停、重载和移除 Provider；DevSpace 不重复实现审批流。
- v1 完整支持 tool discovery/call，并把 resources、resource templates 和 prompts 投影为同一
  Catalog 下的 provider-scoped operation，不新增顶层 REST route。所有协议资产仍受统一输出
  上限、取消、审计和 Provider 生命周期管理。
- 一个下游 MCP 断线只影响该 Provider，不能拖垮现有 workspace MCP 或其他 Providers。

Manifest 增加映射示例：

```json
{
  "id": "mcp.example.server",
  "kind": "mcp-stdio",
  "command": "/absolute/path/to/example-mcp",
  "args": [],
  "tools": {
    "allow": ["search", "read_item"],
    "mappings": {
      "search": {
        "capabilityId": "mcp.example.search",
        "version": "1.0.0",
        "effects": {
          "readOnly": true,
          "destructive": false,
          "idempotent": true,
          "openWorld": true
        }
      }
    }
  }
}
```

这使内置 Provider 和外部 MCP 使用完全相同的 Policy、Lease、Invocation、Audit、并发与测试
框架；Chrome DevTools MCP 只是带预置安全映射的 `McpClientProvider` 专用配置/子类。

## 11. 第一内置 Provider：当前 Chrome

### 11.1 连接策略

`ChromeDevToolsProvider` 复用官方 CLI 管理的用户级 daemon：

```text
DevSpace ProviderSupervisor
  -> current-user Unix socket / Windows named pipe
  -> chrome-devtools daemon (across DevSpace restarts)
  -> one MCP StdioClientTransport
  -> tools/list + tools/call
  -> 当前用户已运行的 Chrome / CDP
```

DevSpace 不会为每次调用执行 CLI，也不会再启动第二个 `chrome-devtools-mcp --autoConnect`
stdio child；它直接实现 daemon 的 NUL framed request/response protocol。CLI、CI 与 DevSpace
因此共享一个已经由 Chrome 确认的连接。Provider stop/reload 不停止用户级 daemon，只有 daemon
不存在时才运行 manifest 中固定的 `chrome-devtools start --autoConnect ...`。官方协议没有
call cancellation；DevSpace 在调用跨 socket 后即使上游超时，也会保持该 downstream operation
占位，直到真实响应或有界 daemon deadline，避免连续叠加请求。

当前推荐路径已经调整为 Extension-first：Native Messaging Extension 是日常浏览器控制的
默认 backend，Chrome DevTools 保留为深度调试 backend。二者都位于 `browser.control` 内部
路由之后，不向模型暴露实现型 Capability ID；不能静默退化为隔离 Profile。

一级 Capability MCP API 固定为
`capability_list/search/describe/open/invoke/status/cancel/close` 八个工具。Browser 新增能力只能
作为二级 Capability 注册，禁止新增 `browser_*` 一级 MCP tool。详见
`docs/capability-api-principles.md`。

### 11.2 Capability 映射

Browser Control Provider 使用显式 canonical 映射表保持稳定产品能力面；通用外部 MCP 则可
选择 `discoverAllTools`。Capability ID 描述业务意图，而不是 Chrome/Extension/CDP 实现：

第一批只读：

```text
browser.profile.list
browser.tab.list
browser.page.snapshot
browser.page.screenshot
browser.debug.console
browser.debug.network
```

第二批 mutation：

```text
browser.page.navigate
browser.page.click
browser.page.type
browser.page.select
browser.page.press
browser.page.scroll
```

每项映射固定：上游 tool name、输入 Schema 版本、输出归一化、effect、权限、默认超时和
lease 要求。上游升级新增/改变工具时，digest mismatch 应让该项进入 incompatible 状态，
而不是自动扩大能力。

### 11.3 页面选择与所有权

- `list_pages` 不需要页面 lease，但返回最小必要的 page selector、title 和安全 URL 摘要。
- 除 `list_pages` 外，所有页面能力需要 lease。
- URL 日志只保留 origin 或经过策略允许的脱敏形式；包含 token/query 的 URL 不落审计。
- 默认只能操作调用者显式 `open`/adopt 的一个页面。
- 不允许用“当前选中页”作为长期隐式全局状态。
- 页面关闭、目标变更、Chrome 重启后 lease 立即失效。
- 多 principal 并发 adopt 同一页面默认冲突；管理员策略可允许只读共享，mutation 仍需独占。
- Provider 的 CDP 能访问整个 Profile 不代表调用者获得整个 Profile 的授权。

### 11.4 首次权限和常驻

首次 `--autoConnect` 通常需要用户在 Chrome 中确认连接。正确流程：

1. 用户处于登录且解锁的图形会话。
2. 管理员启用 Provider 或运行 `devspace capabilities doctor --provider ...`。
3. Supervisor 启动 Provider；若 Chrome 提示授权，状态进入 `needs_user_action`。
4. 用户在 Chrome 中确认一次。
5. Provider 验证 `list_pages` 和只读 snapshot，记录权限状态而非任何 Cookie/token。
6. 后续调用复用常驻连接；断线时 Supervisor 重连。

是否在 Chrome/系统重启后仍不提示由 Chrome 本身决定，不能由 DevSpace 保证或绕过。若需要
更稳定的 current-Chrome 连接，Native Messaging 扩展是可控路径，但它仍需要一次扩展安装、
Native Host 注册和高权限告知。

### 11.5 锁屏支持矩阵

锁屏不是一个布尔“支持/不支持”，要按能力分类和真实验证：

| 能力 | 屏幕锁定后预期 | v1 策略 |
| --- | --- | --- |
| 已建立 CDP 连接上的页面 JS/DOM/网络读取 | 可能继续，取决于 Chrome/系统是否挂起 | 条件允许，必须做真实 soak |
| 页面导航、CDP click/type | 可能继续，但会改变用户会话状态 | 目标 lease；审批由上层 Agent 完成；记录 locked 状态 |
| Chrome 页面截图 | 通常可由渲染管线产生，但不可假设 | 验证通过后按版本能力矩阵启用 |
| 首次 Chrome 授权、重连时的用户确认 | 不可在锁屏完成 | `permission_required` |
| macOS 桌面截图 | 锁屏/TCC 下通常不可可靠使用 | 拒绝或 `temporarily_unavailable` |
| AX 点击、键盘、窗口激活 | 锁屏时没有可操作的普通前台会话 | 拒绝 |
| 登录窗口、密码、Touch ID、FileVault | 不允许自动化 | 永久策略拒绝 |

Runtime 需要一个 `SessionStateProbe`，至少输出 `awake`、`loggedIn`、`locked`、
`consoleUser` 和 `observedAt`。每个 Descriptor 声明运行条件，Router 在调用前校验。Chrome
后台能力不设置 `requiresUnlocked` 本地门，调用审批完全交给上层 Agent；downstream 是否能在
锁屏继续工作由真实连接决定，并记录版本矩阵。首次建立/重连需要图形确认时仍会返回
`permission_required`。电脑 AX/前台输入不是后台协议，仍按 OS 的实际可用性失败。

目标不是尝试绕过锁屏，而是让不需要前台 UI 的浏览器协议操作在系统允许时继续，并对其他
能力给出确定、可恢复的错误。

## 12. 第二内置 Provider：电脑 UI 自动化

### 12.1 macOS Helper 边界

建议独立实现签名稳定的 Swift Helper，以便 Accessibility 和 Screen Recording 权限绑定到
稳定二进制身份，而不是每次由不同 Node/npm 临时进程申请 TCC。

```text
DevSpace Node Runtime
  <-> 当前用户私有 Unix socket
  <-> DevSpace Desktop Helper (Swift, launchd user agent)
       ├── AXUIElement / NSWorkspace
       ├── ScreenCaptureKit
       └── CGEvent（仅允许的键鼠动作）
```

Socket 要求：父目录 `0700`、socket/状态文件仅当前用户、检查 owner、拒绝 symlink、处理 stale
socket、握手带随机 challenge 和 protocol version。Helper 默认只接受本机当前用户，不监听
公网端口。

### 12.2 初始能力

```text
desktop.apps.list
desktop.app.activate
desktop.ui.snapshot
desktop.ui.screenshot
desktop.ui.click_element
desktop.ui.type_text
desktop.ui.press_key
desktop.ui.scroll
```

操作顺序优先 Accessibility element action，其次才是截图坐标 fallback。`snapshot` 返回
snapshot ID 和短期 element handles；所有 element 动作必须引用同一 App/window 的最新
snapshot，UI 变化后返回 stale handle，而不是点击旧坐标。

必须识别 AX secure text field 并对快照值脱敏；是否填写由上层 Agent 审批。用户活跃输入检测、前台 App 改变、
锁屏、显示睡眠或目标窗口消失时，Provider 应中止或让出控制，不与用户抢鼠标键盘。

### 12.3 跨平台预留

未来 Windows UIA、Linux AT-SPI Provider 复用核心 ID 和 Schema。平台差异放在 Descriptor
availability 和 namespaced metadata，不能让同一动作在不同平台具有完全不同参数语义。

## 13. 并发、资源和可靠性

Capability 调用不能占满现有 workspace 命令的资源。建议使用独立 request gate：

- 全局 invocation 并发默认 8。
- 每 Provider 默认 2；UI mutation 默认 1。
- queue 默认 64，满时 `rate_limited`。
- 默认 timeout 30 秒，硬上限 120 秒；Provider 可声明更小值。
- 输出默认上限 4 MiB；截图/大附件以后使用受控 artifact handle，而非内联无限数据。
- cancellation 使用 `AbortSignal` 贯穿 Router 和 Provider；无法取消的 Provider 仍标记取消意图，
  丢弃迟到结果。
- lease TTL 默认 15 分钟，最大值由策略控制；闲置自动回收。
- SSE 慢消费者使用有界 buffer，溢出后发送 resync 事件并断开。

Provider health 不应调用破坏性工具。连续健康失败才重启；一次调用业务错误不能重启整个
Provider。Chrome 导航失败、目标关闭、协议断开和 child crash 必须有不同错误分类。

## 14. 分批实施计划

每一批都要独立可审阅、可回滚，只 stage 本批明确 pathspec。不得 `git add -A`、reset、rebase
或清理无关 worktree。每批完成后在本文“实施记录”补充 commit、测试和未决项。

### Batch 0：基线、契约和证据固化

范围：

- 保存改造前 `/mcp` 的 `tools/list` fixture 和关键工具 JSON Schema。
- 固定 [`参考工程/sources.lock.json`](../参考工程/sources.lock.json) 并确认所有参考 clone。
- 把本文作为架构和实施基线；若决策改变，先写 ADR。
- 记录当前 `npm test`、typecheck、build、Node/OS 版本基线。

验收：

- 没有生产代码变化。
- fixture 可自动比较，且不包含 token、绝对用户隐私路径或网页内容。

### Batch 1：领域类型、Schema 与错误模型

新增：`types.ts`、`descriptor-schema.ts`、`errors.ts`、`redaction.ts` 及单测。

实现：

- Descriptor/Provider/Lease/Invocation/Permission/Error 的 Zod Schema。
- ID、semver、JSON Schema、timeout/effect 不变量校验。
- 错误到 HTTP/MCP 的稳定映射。
- 递归脱敏、长度限制和安全摘要。

验收：

- 合法/非法 Descriptor fixture 完整覆盖。
- unknown field 策略清楚；扩展 metadata 可前向兼容。
- password/token/header/url-query fixture 不出现在快照输出。

### Batch 2：Store、Registry、Catalog Revision 与搜索

新增迁移、store、registry、search 及测试。

实现：

- 新表迁移和 rollback/兼容验证。
- Provider Catalog 原子替换、冲突和 schema digest。
- 精确 list/filter/cursor。
- BM25/FTS 搜索及权限前置过滤。

验收：

- 旧数据库升级、空数据库创建都通过。
- 同名冲突不产生半更新。
- 搜索排序有固定 fixture，不依赖网络或模型。

### Batch 3：Provider SPI、Supervisor 与 Fake Provider

新增 Provider interface、supervisor、runtime skeleton、fake provider。

实现：

- 状态机、单实例、启动/健康/发现、退出和 backoff。
- Runtime 进程级生命周期。
- Fake Provider 支持 read、mutation、slow、crash、schema-change 和 cancellation。

验收：

- 并发启动只产生一个实例。
- crash/backoff/circuit breaker 使用 fake timer 可重复测试。
- Server 关闭不遗留 child/interval/listener。
- Provider failed 时现有 `/mcp` 仍可用。

### Batch 4：Policy、Lease、Invocation Router 与审计

实现：

- principal、grant matcher、effect/argument 策略。
- principal-bound lease、TTL、冲突和清理。
- invocation 队列、并发、幂等、超时、取消、输出校验。
- 脱敏审计和 invocation 状态持久化。

验收：

- adapter 绕过测试：直接调用 Router 同样被拒绝。
- A principal 不能使用 B 的 lease。
- slow/cancel/timeout/late result/queue overflow 有确定结果。
- 审计库不含测试 secret。

### Batch 5：REST、OAuth Resource 与 SSE

实现固定 REST API；扩展 OAuth 为 capability resource/scopes；挂载 router。

验收：

- 无 token、错误 audience、缺 scope、过期 token、refresh 均覆盖。
- `/mcp` 原 token/resource 行为和 fixture 完全不变。
- 列表、搜索、调用、取消、lease、错误 envelope contract tests 通过。
- SSE 断线、慢消费者和重连可恢复。

### Batch 6：固定 MCP Adapter 与 CLI

实现 8 个固定 MCP 元工具和本机 CLI。

验收：

- MCP、REST、CLI 对 Fake Provider 得到相同 Descriptor、结果和错误码。
- 无 Provider 增删时 `tools/list` 固定；有 Provider 增删时也仍固定。
- MCP session 多开不会重复启动 Provider。
- CLI `--json` 输出稳定、stdout 无日志污染、退出码可用于 CI。

### Batch 7：Chrome Provider 只读路径

先以独立提交实现并集成通用 `McpClientProvider`（stdio + Streamable HTTP）、Manifest 校验、
tool allowlist/mapping、list-changed 刷新和 fake downstream MCP contract tests；再实现
`ChromeDevToolsProvider` 预置，只启用只读映射。

验收必须使用用户当前 Chrome：

- 解锁状态完成一次授权。
- 能列出真实当前页面、建立 lease、snapshot 和 screenshot。
- 不创建第二个隔离 Chrome/Profile。
- 两个 MCP/REST clients 共用一个 Provider child，但 lease 相互隔离。
- Chrome 退出/重启、MCP child crash 后状态、退避和恢复符合设计。
- 上游 tool Schema 改变时 fail closed。

### Batch 8：Chrome mutation、策略与锁屏矩阵

实现导航、点击、输入、按键、滚动的显式映射和 grant。

验收：

- 只在本地测试站点/fixture 上执行，不操作真实账户或生产数据。
- 未授权 mutation 失败；授权后按目标 lease 成功。
- secure/password field 的快照值必须脱敏；输入审批由上层 Agent 完成。
- 用户关闭/切换目标、并发 mutation、过期 lease 行为确定。
- 分别验证“解锁建立连接后锁屏”和“锁屏期间 Provider 重启”场景。
- 形成 OS/Chrome/Provider 版本化能力矩阵；未通过项保持 `requiresUnlocked=true`。

### Batch 9：macOS Desktop Helper

分成 Helper transport、只读 AX/screenshot、mutation 三个独立提交。

验收：

- Helper 签名身份稳定，Accessibility/Screen Recording 不反复请求。
- socket ownership/symlink/stale/非当前用户连接测试通过。
- snapshot handle、窗口切换、secure field、用户活跃让出、锁屏拒绝通过。
- 使用自建 UI fixture 做真实 click/type/scroll，不用桌面上偶然存在的 App 状态。

### Batch 10：硬化、文档和发布开关

完成 fuzz/soak、资源上限、故障注入、升级兼容、operator runbook 和威胁模型复审。

只有满足第 16 节完成定义后，才考虑把 `DEVSPACE_CAPABILITIES` 默认改为 1。Chrome mutation
和 Desktop Provider 可继续各自默认 disabled，即使 Catalog/只读 Runtime 已默认启用。

## 15. 测试与验收证据矩阵

### 15.1 自动化测试

| 层级 | 重点 |
| --- | --- |
| Unit | Schema、错误、搜索、policy、redaction、lease、状态机 |
| Contract | REST OpenAPI fixture、MCP tools/list/call、CLI JSON |
| Integration | Fake stdio MCP、child crash、timeout、cancel、OAuth、SQLite migration |
| Security | audience/scope、lease 越权、manifest ownership、symlink、secret 泄露、SSRF/URL policy |
| Reliability | 多 client、Provider restart、queue overflow、catalog churn、server shutdown |
| Real Chrome | current profile、页面 lease、snapshot、mutation、重启、锁屏 |
| Real macOS | TCC、AX fixture、ScreenCapture、用户活跃、锁屏、Helper restart |

### 15.2 每批必须报告的证据

- `git status --short` 和本批完整 diff。
- 实际运行的 typecheck/test/build 命令及退出码。
- 新增/修改测试名称和通过数量。
- 是否只用了 Fake Provider，还是完成了真实 Chrome/真实桌面路径。
- Provider、OS、Chrome、Node、MCP 包的实际版本。
- 权限状态、锁屏状态和用户控制步骤；不能把“已有权限”描述成“代码自动获得权限”。
- 失败项、日志路径、可重试步骤和安全回滚方式。

### 15.3 真实 Chrome fixture

建立本地静态测试页，包含：按钮、文本框、secure input、滚动区、弹窗、新标签、网络请求、
可访问性标签和动态 DOM。测试不得依赖公网网页 UI。需要另设一个明确的外部只读页面验证
openWorld 策略，但不得登录、提交表单或修改真实数据。

### 15.4 Soak 建议

- 2 小时：每 5 秒 list/status，每 30 秒 snapshot；周期性创建/释放 lease。
- 8 小时：Chrome 正常运行，包含显示睡眠/唤醒但不锁屏的阶段。
- 8 小时：解锁建立连接后锁屏，执行允许的只读 CDP 操作并记录成功率。
- 故障注入：杀 Provider child、关闭页面、退出 Chrome、断开 MCP transport、使输出超限。
- 记录峰值 RSS、child 数、FD、listener、队列、P50/P95/P99 和恢复时长。

## 16. 完成定义（Definition of Done）

整体方案只有同时满足以下条件才算落地：

- 现有 `/mcp` tools/list 和关键 Schema 与基线一致，现有测试全部通过。
- 固定 REST v1、固定 MCP 元工具和 CLI 对同一 Runtime contract tests 通过。
- 通用 stdio/Streamable HTTP MCP 能挂载、筛选、注册和调用工具；下游变更只更新 Catalog
  revision，不能改变固定元 API，也不能把 Provider instructions 当作可信指令。
- Catalog 能列出、搜索、描述 Provider 能力，动态变化只增加 revision，不改变元 API。
- OAuth audience、delegated/enforced policy、lease ownership、并发、超时、取消和审计均有测试。
- 已认证 Agent 可以提交 stdio/HTTP Manifest；其 executable/args 权限与本机服务用户一致，
  DevSpace 不添加 executable/origin/env/action 白名单，审批由上层 Agent 负责。
- Chrome 只读路径已在用户当前 Chrome 真实验证，没有启动隔离 Profile。
- Chrome mutation 需要目标 lease；默认不需要 Grant，也不拦截 secure field，审批由上层 Agent 完成。
- Chrome 锁屏支持形成真实版本矩阵；未验证项没有被声明为支持。
- macOS Helper 权限绑定稳定二进制，AX/截图/输入和锁屏边界有真实证据。
- 服务重启、Provider crash、Chrome restart、客户端并发和 shutdown 不泄漏资源。
- 文档包含安装、授权、doctor、调用、故障恢复、禁用和卸载步骤。
- capability feature flag 和 Provider enabled 状态可显式配置；尚未通过实机验收的 Provider 不宣称可用。

## 17. 风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| MCP client 缓存工具列表 | 动态工具不可见或调用失败 | v1 固定元工具，动态数据进 Catalog |
| Chrome 当前 Profile 权限过大 | 可见全部标签、Cookie 相关页面 | 显式 lease、最小摘要、target policy、默认只读 |
| Provider child 获得被映射环境变量 | secret 泄漏或命令注入 | 上层 Agent 审批、absolute executable、shell=false、显式 envFrom、manifest ownership、审计 |
| OS/Chrome 升级改变 autoConnect | 后台连接失效 | doctor、Schema digest、状态机、Extension fallback、版本矩阵 |
| 锁屏能力被过度承诺 | 自动化中途失败或触碰安全边界 | Descriptor runtime conditions、SessionStateProbe、真实 soak、fail closed |
| 桌面坐标点击漂移 | 点击错误目标 | AX 语义优先、snapshot handles、窗口绑定、坐标 fallback 分级 |
| 多 Agent 争用页面/鼠标 | 相互干扰 | principal lease、独占 mutation、冲突错误、用户活跃让出 |
| 大截图/网页输出耗尽内存 | 服务不稳定 | 输出限制、artifact handle、独立 gate、背压 |
| Provider 升级悄悄扩大工具 | 意外能力出现 | 显式工具映射、Schema digest、Catalog revision |
| 把 DevSpace token 当作 OS 权限 | 反复提示或错误安全假设 | 连接认证、可选 enforced-policy、OS permission 三层独立状态和文档 |

## 18. 给后续实施 Agent 的交接指令

1. 先读根目录 `AGENTS.md`、本文、[`参考工程/README.md`](../参考工程/README.md)、
   `docs/security.md`、`docs/mcp-resource-control.md` 和 `docs/workspace-control-plane.md`。
2. 开始每一批前执行 `git status --short --untracked-files=all` 并查看完整 diff；当前工作树可能
   有其他 Agent 的并行改动，不能覆盖、清理或重新格式化无关文件。
3. `参考工程/*` 是只读研究材料。不要在第三方 checkout 中实现，也不要把嵌套仓库提交到
   DevSpace 主仓库；需要复用代码时先核对 LICENSE/NOTICE 并尽量自行实现接口。
4. 严格按 Batch 0 到 Batch 10 推进。允许把一批拆小，不允许跳过策略/租约先暴露 mutation。
5. 每批只 stage 明确文件路径；禁止 `git add -A`、`git reset --hard`、rebase、amend 和为整洁
   删除并行 WIP。
6. 领域逻辑放在 `src/capabilities`，不要继续膨胀 `src/server.ts`；REST/MCP/CLI 都只能适配
   `CapabilityRuntime`。
7. 先用 Fake Provider 完成确定性测试，再接真实 Chrome。真实 Chrome 测试必须确认连接的是
   用户当前 Profile，记录版本和页面 fixture，不以 daemon `status` 代替实际 tool call。
8. 遇到 Chrome 首次授权、macOS TCC、解锁或签名步骤时，停在清楚的用户控制门，报告当前
   状态和单一步骤；不得模拟点击安全提示或设计绕过。
9. 每批更新下面的实施记录，写 commit、命令、真实/模拟证据和剩余风险。没有真实路径证据时
   明确写“仅 Fake/Integration”，不能写“已完成 Chrome/桌面支持”。
10. 若必须改变本文的外部 API、信任模型或不变量，先新增 ADR 并请求审阅；不要在代码中
    悄悄改变。

## 19. 实施记录

后续 Agent 按批追加，不覆盖历史：

| Batch | 状态 | Commit | 自动化证据 | 真实路径证据 | 未决项 |
| --- | --- | --- | --- | --- | --- |
| 0 | 完成（2026-09-13） | 本提交 | typecheck、完整 test、build、三种 tool mode 契约快照 | 不适用 | 生产能力代码尚未开始 |
| 1 | 完成（2026-09-13） | 本批提交 | Descriptor JSON Schema、错误映射、递归脱敏单测 | 不适用 | Runtime 尚未接线 |
| 2 | 完成（2026-09-13） | 本批提交 | SQLite v5、原子 Catalog、revision/cursor、冲突与 BM25 搜索测试 | 不适用 | Provider binding 重启后按设计需重新发现 |
| 3 | 完成（2026-09-13） | 本批提交 | 单实例、发现、崩溃退避恢复、权限门、禁用与关闭测试 | Fake Provider | 周期 health polling 留待硬化批次 |
| 4 | 完成（2026-09-13） | 本批提交 | Grant、lease 越权、Schema、队列、幂等、取消、超时、输出上限和脱敏审计 | Fake Provider | Grant 持久化管理入口留待 API/CLI 批次 |
| 5 | 完成（2026-09-13） | 本批提交 | REST catalog/search/lease/invoke/error/SSE；OAuth token/scope/audience/expiry 与双 resource metadata；完整 test/build/旧 MCP 契约 | Fake Provider + HTTP OAuth client | SSE 采用 resync 快照恢复；持久事件回放留待硬化批次 |
| 6 | 完成（2026-09-13） | 本批提交 | 固定 8-tool MCP contract、共享 policy/invocation、CLI JSON stdout/退出码、旧 MCP 契约 | Fake Provider 经 MCP、REST 与 CLI | CLI 通过本机 REST；OAuth 模式需 `DEVSPACE_CAPABILITY_BEARER_TOKEN` |
| 7 | daemon 复用完成、DevSpace 实机调用待解锁复验（2026-09-13） | 本批提交 | 通用 MCP Manifest、stdio+HTTP；Chrome 固定映射、lease、串行目标；CLI daemon socket 协议、ownership、framing、取消后不叠加请求测试 | Chrome 152.0.7977.83 + chrome-devtools-mcp 1.9.0；当前 Profile 的 CLI list/snapshot/screenshot 已通过；DevSpace 与 CLI 只保留一个 daemon | 解锁后重建 daemon，完成 DevSpace REST fixture snapshot/screenshot、重启与异常页验证 |
| 8 | 代码完成、实机锁屏矩阵部分完成（2026-09-13） | 本批提交 | Chrome mutation 显式映射、持久 Grant 兼容 API/CLI、macOS session probe；Chrome 不设本地 unlocked 门，默认审批委托给上层 Agent | 锁屏时 Codex Chrome 扩展仍可枚举 26 个当前 Profile 页并读取本地 fixture 的 AX 快照；锁屏后新建 DevTools daemon 的 status 成功而 list_pages 60 秒无响应 | 解锁建立 daemon 后再锁屏，验证 list/snapshot/screenshot/mutation；扩展通道结果不等于 DevTools 通道通过 |
| 9 | 核心路径完成、真实用户活跃/锁屏门待补（2026-09-13） | 本批提交 | 原生 Swift MCP Helper、稳定 identifier 签名脚本、应用 lease 绑定、AX 有界快照、应用所属 layer-zero 窗口截图、近期硬件输入让出、激活/点击/安全输入/按键、secure value 脱敏、Provider 单测 | 本机真实编译/MCP 握手；Accessibility/ScreenCapture 预检均为 true；空白 Fixture App 的 AX、Unicode 输入、限定窗口 PNG 截图真实 canary 通过 | 生产 Developer ID 签名、真实用户活跃让出与锁屏实测 |
| 10 | 框架与 10m soak 完成、24h/实机 soak 待验收（2026-09-13） | 本批提交 | 独立临时 DevSpace + 真实 stdio MCP fixture；REST/MCP 并发、固定 8-tool、session churn、队列限流/恢复、幂等、取消、超时、输出上限、secure intent、child crash/backoff/recovery、进程树 RSS/FD/socket、关机无孤儿；最终 delegated-approval 10m 为 43,025/43,025 调用、5,000 churn、26 项门全通过、调用 p95 23 ms、峰值 RSS 603.84 MiB | 仅隔离 Fixture，不等同于 Chrome/桌面实机 soak | 24h soak 尚未运行；Chrome 授权、真实锁屏、真实用户活跃让出仍是显式验收门 |
| 11 | 完成（2026-09-13） | 本批提交 | 固定 REST admin API；固定 MCP 的 `capability_invoke` 调用动态 `devspace.providers.*` 管理能力；默认 grantless delegated approval、enforced-policy 显式兼容开关；Manifest 安全存储；进程内 install/enable/disable/reload/remove；Catalog revision 与 8-tool 不变端到端测试 | 真实 stdio Fake MCP 子进程动态装载、重载和回收 | 包下载/供应链审批由上层管理 Agent 负责 |
| 12 | 完成（2026-09-13） | 本批提交 | Manifest `discoverAllTools`；下游 tools/list 自动生成稳定 capability ID、Schema、描述和保守 effect 元数据；显式映射可覆盖；REST/MCP 自动发现与调用端到端测试 | 真实 stdio Fake MCP 的未映射工具自动进入 Catalog 并可由固定 `capability_invoke` 调用 | resources/prompts 后续投影见 Batch 28 |
| 13 | 框架完成、三阶段实机执行待解锁（2026-09-13） | 本批提交 | `test:current-chrome` 对 lock-state 前置条件、daemon persistence、固定九能力、list、lease、snapshot、screenshot、同页 navigation 和脱敏 JSON/Markdown receipt 做统一验证 | 当前锁屏环境的 unlocked-baseline 预检在任何页面调用前按预期失败并生成 receipt | 用户解锁后依次运行 unlocked-baseline、locked-continuation、unlocked-recovery |
| 14 | 扩展桥接代码、产品化与测试完成，实机矩阵待解锁（2026-09-13） | `fa02d30`、`577123d` + 本批提交 | MV3 extension、稳定 ID/外置私钥打包、安装与 profile-aware doctor、Native Messaging host、Unix socket bridge、固定八能力、当前标签显式 lease；用户标签仅释放、Agent 标签自动关闭；service-worker ownership 恢复；1 MiB/64 MiB 方向上限、2 MiB 响应、断线/取消/分片、稳定 Node launcher 与隔离安装/打包/doctor 测试；一进程三阶段锁屏矩阵 | CRX/ZIP/unpacked 与 native host 已在本机生成并校验；doctor 准确报告安装材料就绪但 Chrome Profile 启用数为 0；锁屏环境中矩阵在任何浏览器调用前按预期拒绝 | 用户解锁后在当前 Chrome 加载 unpacked extension，并运行 `npm run test:browser-extension` |
| 15 | 完成（2026-09-13） | `61b1adc` | `waitForHttpServerListening`、未监听关闭兼容与真实端口冲突回归；完整 test/build | 本机 7676 已占用时新实例退出码 1，只输出 EADDRINUSE，不虚报 listening、不抛二次关闭异常 | 无 |
| 16 | 完成（2026-09-13） | 本批提交 | `test:real-mcp-mount` 使用实际安装的开源 `chrome-devtools-mcp`，经固定 MCP 动态 install/search/enable/reload/remove，并经 REST disable；校验外层恒为 8 tools、自动发现 29 capabilities、Provider 进程 1→0、Catalog revision 2→7，生成 JSON/Markdown receipt | `chrome-devtools-mcp` 1.9.0 实际子进程；浏览器端点故意指向不可达 loopback，未读取用户页面 | 页面自动化实机证据仍由 current-Chrome 与 extension lock matrix 单独承担 |
| 17 | 非锁屏交付完成，长时与解锁恢复验收后台/延期（2026-09-13） | `4b61ba1`、`439880d` | 外层 MCP 精确固定为 8 tools；插件默认发布 25 个 canonical `browser.*` 能力；内部 Chrome DevTools 映射默认隐藏、显式诊断可见；默认 delegated approval，浏览器上传不套用 workspace allowlist；`npm run typecheck`、完整 `npm test`、`npm run build` 全通过；当前提交 smoke 80/80、invocation p95 27 ms、23/23 gates、峰值 RSS 340.13 MiB、无孤儿 Provider | 用户当前 Chrome Profile 的 Extension v0.2 已完成 unlocked baseline；既有连接在锁屏阶段 snapshot/screenshot 延续成功；真实 macOS desktop 锁屏边界验证为 status 可用且 AX/input/lease fail closed | 按用户决定，完整 lock→unlock 自动重连矩阵后续复测；24h release soak 已在后台运行，产物根目录 `.build/capability-stress-soak-24h-final-v8` |
| 18 | 当前 HEAD 通用 MCP 实链复验完成（2026-09-13） | `e8be6be`（被测代码） | `npm run test:real-mcp-mount`：固定外层 8 tools、动态 install/search/enable/reload/disable/remove、Catalog revision 2→7、Provider child 0→1→0 | 本机实际 `chrome-devtools-mcp` 1.9.0，自动发现 29 capabilities；receipt：`.build/real-mcp-mount/2026-09-13T07-50-04-564Z` | 浏览器端点按测试设计为不可达 loopback，因此此项只证明真实 MCP 包管理与 Runtime 链路，不替代当前 Chrome 页面验收 |
| 19 | 持久历史硬化完成，替换 24h soak 运行中（2026-09-13） | `ba9bab5` | SQLite invocation/audit 数量+时间双重裁剪，active invocation 保留；全量 `npm test`、typecheck、build 通过；跨界负载 2,400/2,400，最终 2,000 invocation、4,949 audit、3.62 MiB、26/26 gates | 第一轮 24h 在约 1h30m 暴露 362,341 invocation、724,682 audit、566 MiB 无界增长后受控停止，临时目录移入废纸篓 | 修复版 24h 从 `ba9bab5` 启动，会话 `54869`，产物根目录 `.build/capability-stress-soak-24h-bounded-final`；最终 receipt/cooldown 待完成 |
| 20 | 本机生产服务接线完成，锁屏恢复后测（2026-09-13） | `cadf07c` + 本批文档提交 | 当前 HEAD 完整 `npm test` 通过；线上 `/capabilities/mcp` 实际 `tools/list` 精确返回固定 8 tools；`/healthz` 返回 capabilities enabled、Catalog revision 14；LaunchAgent 服务与当前 Tunnel 均为 running | `127.0.0.1:7676` 已启用 Capability Runtime；`browser.control` 与 `devspace.providers.admin` 均 ready，目录返回 25 个 canonical `browser.*` 能力；修复两段式 Provider ID `browser.control` 被旧三段式 Schema 拒绝的实链问题 | 锁屏时 `browser.profile.list` 成功但 profiles 为空，只证明 Provider/桥接运行时就绪，不宣称当前 Chrome 已连接；完整 lock→unlock 恢复矩阵按用户决定后续执行；有界 24h soak 仍在运行 |
| 21 | 桌面 Provider 动态上线与稳定签名宿主完成，系统授权待解锁（2026-09-13） | `e87eee4` + 本批提交 | Provider health 增加可复用的 `unavailablePermissions`；目录只把受影响 Descriptor 标为 `permission_required`；固定 App Bundle 打包、签名 doctor、拒绝覆盖与可恢复安装测试进入 `npm test`，当前完整测试和 build 通过 | 经固定 `devspace.providers.install/control` 能力动态安装、热重载并跨 DevSpace 重启恢复 8 项 `desktop.macos.*`；`DevSpaceDesktopHost.app` 以非 ad-hoc 稳定身份签名并安装到 `/Users/ai/Applications`，线上 Manifest 已指向固定 executable | LaunchAgent 实际执行链正确报告 Accessibility、Screen Capture 均未授予，Provider 为 degraded；直接父进程的既有授权不作为证明。解锁后只对固定 App 集中授权，再执行 fixture AX/screenshot/mutation 与恢复验收 |
| 22 | 桌面真实 Provider 非写入性能框架完成（2026-09-13） | 本批提交 | 新增 `test:desktop-provider-performance`：固定 8-tool、精确 8-capability 目录、REST/MCP 双链、权限一致性、PID、p50/p95/p99、RSS 门与 JSON/Markdown receipt；类型检查通过 | 锁屏线上 7676 实测 PASS：REST status 50/50、p95 42 ms；MCP status 25/25、p95 47 ms；Provider PID 稳定；RSS 11,552→12,608 KiB；零错误；receipt `.build/desktop-provider-performance/2026-09-13T08-30-20-747Z` | 此 canary 故意只读，不替代解锁后的 AX/screenshot/input、Helper restart 和 lock-transition 验收 |
| 23 | 桌面真实 Provider 热重载恢复门完成（2026-09-13） | 本批提交 | `test:desktop-provider-performance -- --reload-provider` 通过固定 MCP 调用动态 Provider control，验证 reload 返回、旧 PID 退出、新 PID 状态调用和权限状态一致 | 锁屏线上 PASS：20 REST + 10 MCP 状态调用；REST/MCP p95 39/42 ms；reload 106 ms；旧 PID 66140 已退出，新 PID 97773；receipt `.build/desktop-provider-performance/2026-09-13T08-32-04-975Z` | 仍不执行锁屏桌面动作；解锁后的真实 UI fixture 与多次转换验收后续进行 |
| 24 | 桌面租约绑定进程世代完成（2026-09-13） | `db6a0da` | `app_window` lease 保存 bundleId+PID；Provider 调用前重新枚举验证，Helper 执行时再次验证并按精确 PID 检查前台；参数覆盖返回 policy denial、旧 PID 返回 lease expired；Helper 0.3.0、6 项租约能力 2.0.0；完整 `npm test`、typecheck 与原生编译通过 | 锁屏下只执行了不存在 PID 的安全拒绝 canary，Helper 返回明确 stale-process 错误，没有触发任何 UI 动作；签名 Host 0.3.0 与线上 Manifest 已动态升级，生产状态和 reload canary 均通过 | 解锁后验证真实应用重启使旧 lease 失效 |
| 25 | Provider reload 目录连续性修复完成（2026-09-13） | `695ccca` | reload 停旧/启新期间保留 Descriptor，健康状态转为 stopping/starting，调用稳定返回 provider unavailable 而非 capability not found；新 discovery 完成后原子替换；disabled reload 仍退休目录；完整 `npm test` 与 typecheck 通过 | 升级桌面 Host 的并行调用真实捕获了旧行为的瞬时 `capability_not_found`，成为本修复的生产复现证据 | 代码门已完成；生产连续性证据见 Batch 26 |
| 26 | Provider reload 生产目录连续性门完成（2026-09-13） | 本批提交 | 桌面 Provider 性能 canary 在动态 reload 未完成时持续请求 `desktop.macos.status` Descriptor，任何 404/`capability_not_found` 立即失败；文档明确该门不替代解锁后的 UI 验收；typecheck、build 通过 | 锁屏线上 PASS：reload 84 ms；期间 148 次 Descriptor 探测全部成功；旧 PID 57492 已退出，新 PID 57795 恢复；REST 状态 p95 42 ms、MCP 状态 p95 35 ms、RSS 增长 528 KiB；receipt `.build/desktop-provider-performance/2026-09-13T08-43-00-935Z` | 锁屏状态转换、浏览器插件恢复和桌面 UI fixture 按用户决定留到解锁后；24h 有界 soak 继续运行 |
| 27 | 统一 release lane 与生产桌面 Fixture 框架完成，locked lane 通过（2026-09-13） | `ac6d47a`、`a5421a0` | `test:capability-release` 记录 commit、全部 dirty paths、runtime-source dirty 子集、逐门日志和 JSON/Markdown receipt；按 core/locked/unlocked/browser-transition 编排，targeted rerun、跳过、源码脏树和前置条件失败均不能形成 release-eligible receipt；`test:desktop-runtime-fixture` 覆盖固定 REST API→Runtime→动态 Provider→签名 Host→Fixture App，并验证 AX 脱敏、窗口截图、输入和应用重启后旧 lease 失效 | 基于 runtime source clean 的 `a5421a0` 完整 locked lane 7/7 通过：typecheck、完整 test、build、capability stress smoke、真实 `chrome-devtools-mcp` 挂载、桌面锁屏边界、线上 reload 连续性；receipt `.build/capability-release/2026-09-13T08-59-34-678Z`，仅记录并忽略并行文档 WIP | unlocked 与 browser-transition lane 需解锁；24h soak 独立完成后才形成最终 release evidence set |
| 28 | 通用 MCP 协议资产投影完成并回归通过（2026-09-13） | `0ee0ed8`、`28a3ef5` | 下游初始化声明 `resources`/`prompts` 时自动注册 provider-scoped list/templates/read/get 动态 Capability；固定外层仍为 8 tools；调用沿用 Schema、取消、超时、输出限制与审计；binding key 隔离避免恶意 tool name 与协议方法碰撞；stdio 单测覆盖五个协议方法及非法 prompt 参数；完整 `npm test`、typecheck、build 通过 | 真实 stdio Fake MCP 经 REST 读取 Resource、经固定 MCP 获取 Prompt；无相关 server capability 的 HTTP MCP 不产生虚假 Descriptor；当前代码 smoke 80/80、调用 p95 25 ms、26/26 gates、峰值 RSS 339.72 MiB、无孤儿；真实 `chrome-devtools-mcp` 1.9.0 仍为 29 项能力且 Provider child 1→0、外层 8 tools 不变；receipts `.build/capability-stress-mcp-assets/2026-09-13T09-14-09-077Z`、`.build/real-mcp-mount/2026-09-13T09-14-26-270Z` | 当前 24h soak 在本批之前启动；真实第三方 resource/prompt MCP 可作为后续兼容性扩展，不阻塞协议实现 |

## 20. 推荐阅读顺序

落地前按最短路径阅读参考实现：

1. Docker MCP Gateway：`dynamic_mcps.go`、`capabilitites.go`、`tool_policy.go`、
   `clientpool.go`、`reload.go`。
2. 官方 MCP Registry：OpenAPI、server.json 和 extension namespace 文档。
3. Chrome DevTools MCP：daemon、client、socket/PID 安全和 `--autoConnect`。
4. Munim：Native Messaging、BrowserBridge、tab ownership 和 secure field 拒绝。
5. Qwen Open Computer Use：Accessibility snapshot、element handle、permissions 和 smoke suite。
6. MacOS-MCP：AX、ScreenCapture、launchd 和权限诊断；不要照搬任意 shell/osascript。

更详细的固定提交、许可证和具体文件链接见
[`参考工程/README.md`](../参考工程/README.md)。
