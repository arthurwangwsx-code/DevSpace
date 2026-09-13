# DevSpace 能力平台收尾与 Control Center 审查交接

日期：2026-09-13（Asia/Kuala_Lumpur）

## 1. 交接范围

本文交接两部分状态：

1. 已完成的通用 Capability Runtime、动态 MCP、浏览器与桌面能力及测试框架。
2. 图形化 `DevSpace.app` / Control Center 首轮只读审查发现的问题。

本文不授权改变公共 Capability MCP 契约。外层必须继续固定为
`capability_list/search/describe/open/invoke/status/cancel/close` 八个工具；浏览器、桌面、设备、
App 以及未来能力只能注册为第二层 Capability，不能新增领域专用的第一层 MCP 工具。

## 2. 当前权威状态

- 主分支：`bp/master`
- 本次交接前 HEAD：`8db815cc338996495798bdb0983ed0667f91ce5d`
- 主工作树：干净
- 已完成 core release：5/5 gates，`releaseEligible=true`
- 回执：
  `.build/capability-release-current/2026-09-13T13-34-43-206Z/summary.json`
- 生产服务仍运行旧发布 `1.0.4+d5b9a9cb5a04`，PID `63797`；为避免影响外部 Agent，
  本轮没有部署或重启。
- 24 小时 Capability soak 是一次性进程，不是定时任务。最后核对时 runner `29383`、
  `caffeinate` `29384`、隔离 DevSpace `29388`、fixture `29390` 均存活，已运行约 5 小时
  45 分钟。
- 名为 `DevSpace 24h soak monitor` 的小时级 Codex heartbeat 已删除，不会再自动唤醒本对话。

以上 PID、运行时长和生产 release 属于时间点快照，后续 Agent 必须重新核对，不能直接当作当前事实。

## 3. 已完成能力

- 固定八工具 Capability MCP，以及共用 REST、CLI 和 Runtime 契约。
- Catalog 的 list/search/describe、revision、游标与能力状态。
- 动态 Provider install/update/enable/disable/reload/remove，并保持外层工具集合不变。
- 通用 stdio / Streamable HTTP MCP 挂载；自动投影 tools、resources、resource templates 和 prompts。
- 默认 delegated approval，不要求 DevSpace Grant；审批责任交由调用它的上层 Agent。
- Browser Extension → Native Messaging Host → Unix socket → Browser Provider 当前 Profile 路径。
- `chrome-devtools-mcp` 动态挂载、生命周期和真实包回归。
- macOS Desktop Provider、稳定签名 Host、Accessibility/Screen Recording 诊断及真实 UI fixture。
- Provider 热重载目录连续性、服务自恢复激活和生产 Workspace MCP 命令 canary。
- 独立性能/可靠性框架：REST/MCP 并发、固定工具面、session churn、限流、取消、超时、
  输出上限、故障恢复、RSS/FD/socket、SQLite 有界历史、孤儿进程和 release lanes。
- 长时压测现会原子更新 `progress.json`，外部进程可以安全读取 running/complete/failed 状态、
  阶段、完成度、进程资源及持久状态摘要。

相关设计和证据入口：

- [`capability-runtime-implementation-plan.md`](capability-runtime-implementation-plan.md)
- [`capability-stress-testing.md`](capability-stress-testing.md)
- [`distribution-and-control-center.md`](distribution-and-control-center.md)
- [`product-capability-map.md`](product-capability-map.md)

## 4. Control Center 待处理问题（本轮关闭中）

### P0-1：自定义端口没有传入服务安装器

[`src/control-center.ts`](../src/control-center.ts) 中 `service.install/start/restart` 调用
`install-service.mjs` 时没有传递当前配置的 `--host` 和 `--port`。
[`scripts/macos/install-service.mjs`](../scripts/macos/install-service.mjs) 又在读取持久配置前直接采用
`127.0.0.1:7676` 默认值。用户在 GUI 中保存非 7676 端口后，可能出现：

- UI 按自定义端口计算 LaunchAgent label；
- 安装器实际创建 7676 服务；
- 健康检查、启动状态和停止操作指向不同服务。

建议让安装器按“显式 CLI 参数 > `config.json` > 默认值”解析 host、port、stateDir 和
worktreeRoot；Control Center 也可显式传递保存后的值。必须新增“不传 `--port`、只在临时
`config.json` 写入自定义端口”的 plist 契约测试。

### P0-2：Control Center 和 TunnelSupervisor 未进入完整测试链

[`src/tunnel-supervisor.test.ts`](../src/tunnel-supervisor.test.ts) 已存在，但当前
[`package.json`](../package.json) 的 `pretest` 没有执行它；Control Center 本身没有 API 契约测试。
因此 core release 的 5/5 不能证明 GUI 控制面行为。

建议新增 `src/control-center.test.ts`，至少覆盖：

- 仅 loopback 监听、随机端口启动和有界关闭；
- 无 Token、错误 Token、正确 Bearer Token；
- config GET/PUT、非法端口、空 roots、URL 规范化和文件权限；
- status 对真实临时 health fixture 的探测；
- 未知 action 与失败 command 的 HTTP 语义；
- TunnelSupervisor start/stop/restart/backoff、参数替换、环境变量和无孤儿进程。

随后把两组测试加入 `pretest` 和 core release。

### P0-3：Control Center Token 与 HTML 注入面需要硬化

[`src/control-center.ts`](../src/control-center.ts) 当前把 Token 放在 URL query，API 同时接受 query
Token；页面又用 `innerHTML` 拼接部分运行状态和持久配置。虽然服务只监听 loopback，仍应避免
浏览器历史、Referrer 或恶意本地配置扩大控制权限。

建议：

- 页面取到 Token 后立即 `history.replaceState` 清除 query；
- `/api/*` 仅接受 Authorization Header；
- 返回 `Cache-Control: no-store`、`Referrer-Policy: no-referrer` 和严格 CSP；
- 所有进入 `innerHTML` 的动态字符串必须转义，或改用 `textContent`/DOM 构造；
- 为上述行为增加 HTTP 和静态页面契约测试。

### P0-4：已有配置文件权限不会自动收紧

[`src/user-config.ts`](../src/user-config.ts) 使用 `writeFileSync(path, ..., {mode: 0o600})`。
对已经存在的 `0644` 文件，Node 不会仅靠 `mode` 选项修改现有权限。保存配置或认证数据后应显式
`chmodSync(path, 0o600)`，并用预先创建为 `0644` 的 fixture 验证最终权限。

### P1-1：GUI 无法清空 tunnel command/cwd

页面把空输入转换成 `undefined`，`JSON.stringify` 会删除字段；服务端随后认为字段未提供并保留旧值。
应发送 `null` 表示清空，并验证保存、重新加载后确实为空。

### P1-2：空 allowedRoots 的行为不安全且不明确

Control Center 会接受空数组，而运行时的 roots 解析可能回退到 `process.cwd()`。应在保存阶段拒绝空
roots，并向用户显示明确错误，不能静默改变暴露目录。

### P1-3：命令失败仍可能包装成 HTTP 成功

Control Center 的 `runCommand` 会把非零退出码作为普通结果返回，外层 action 仍返回
`{ok: true}`。建议统一失败语义，例如 HTTP 422 + 保留脱敏后的 stdout/stderr/result，避免 UI
把安装、doctor 或 service 操作失败显示成成功。

### P2：正式 App 发布资格仍未完成

当前打包脚本可以生成 ad-hoc 签名 App、ZIP 和 DMG，但还缺少：

- Developer ID 和 hardened runtime 的强制发布门；
- Gatekeeper 必须通过，而不是默认容许 `not-accepted`；
- notarization + staple 的强制发布回执；
- arm64/x64 或 universal 架构矩阵及原生依赖检查；
- 无预装 Node/npm 的干净 Mac 用户账户验收；
- App 移动、首次启动、登录重启、浏览器 Host、Desktop TCC 身份保持；
- 升级、回滚、卸载和配置迁移；
- 打包后没有 `.git` 时仍能提供准确 source/release identity；
- 对复制整个 `node_modules`、删除嵌套 `.bin` 后的运行完整性验证。

这些属于另一个 Agent 的图形化 App/发布工作，不应混入 Capability 公共 API。

## 5. 建议实施顺序

1. 修复 P0-1，并扩展 `service-install.test.mjs`。
2. 建立 Control Center API 测试，纳入 `pretest`。
3. 完成 Token、CSP、输出转义和文件权限硬化。
4. 修复清空字段、空 roots 和 command 失败语义。
5. 运行 typecheck、完整 test、build 和 core release。
6. 在隔离配置目录构建并启动 `DevSpace.app`，不得先覆盖当前生产服务。
7. 最后再进行签名、公证、干净账户、升级/回滚和卸载发布矩阵。

## 5.1 本轮整改执行口径（2026-09-13）

本轮将本文第 4 节的 P0/P1 作为必须清零的 Control Center 发布门，而不是继续保留为后续建议。
整改完成的判定标准如下：

1. Service 安装器严格采用“显式 CLI 参数 > `~/.devspace/config.json` > 默认值”的配置优先级，
   Control Center 的安装/启动/重启动作与状态探测必须指向同一个 host/port。
2. `src/control-center.test.ts` 覆盖 loopback/token/config/status/action 安全和失败语义，并与
   `tunnel-supervisor.test.ts` 一同进入默认测试链。
3. Control Center URL 中的启动 Token 仅用于首次页面 bootstrap；页面加载后立即从地址栏移除，
   `/api/*` 只接受 `Authorization: Bearer`。响应必须包含 `Cache-Control: no-store`、
   `Referrer-Policy: no-referrer` 和 CSP；来自配置/运行状态的数据不得未经转义拼接到 HTML。
4. `config.json` 与 `auth.json` 每次写入后显式收紧至 `0600`。
5. Tunnel `command`/`cwd` 使用 `null` 表达显式清空；空 `allowedRoots` 必须拒绝保存。
6. Control Center 执行的子进程只要非零退出即视为 action 失败，HTTP 返回 422，并保留有界诊断。
7. 完成后本文必须更新为 Closure 记录，逐项写明修复状态和测试证据；不能继续把已解决问题留作 P0/P1。

## 6. 必须保留的运行边界

- 不要为了 GUI 改动新增任何第一层领域 MCP 工具。
- 不要把生产 `/mcp` 健康等同于新 App 已部署或打包合格。
- 不要在外部 Agent 活跃时随意重启 PID `63797`；需要部署时先重新核对当前 PID、Tunnel 和外部调用。
- 不要停止或替换仍运行的 24 小时 soak；最终只认其真实 `summary.json`、cooldown 和资源门。
- 不要自动点击 Chrome 内部安全页面或 macOS TCC；这些仍是用户控制步骤。
- 每批只 stage 明确文件，保留其他 Agent 的并行 WIP。

## 7. 建议验收命令

```bash
npm run typecheck
npm test
npm run build
npm run test:capability-release -- --lane core \
  --output .build/capability-release-control-center

npm run build:control-center-app
npm run package:macos-release
```

正式发布还必须在干净 Mac 用户账户完成 App 启动、登录重启、Tunnel、Browser、Desktop、升级、
回滚和卸载验收；本机源码构建成功不能替代这些证据。

## 8. Closure 状态（2026-09-13）

本轮已完成第 4 节 P0/P1 的代码整改，问题状态如下：

- **P0-1 已解决**：`install-service.mjs` 现在按“显式 CLI 参数 > 持久配置 > 默认值”解析
  host、port、stateDir、worktreeRoot；Control Center 安装/启动/重启服务时也显式传递当前 host/port。
  `service-install.test.mjs` 新增仅依赖临时 `config.json` 的自定义 host/port/state/worktree 契约测试。
- **P0-2 已解决**：新增 `src/control-center.test.ts`，并把 Control Center、TunnelSupervisor 测试纳入
  默认 `npm test`。覆盖 loopback bootstrap、Bearer 鉴权、query token 拒绝、安全响应头、配置保存、
  空 roots、Tunnel 显式清空、0600 权限和命令失败语义。
- **P0-3 已解决**：页面 bootstrap 后立即 `history.replaceState` 清除地址栏 Token；`/api/*` 仅接受
  Authorization Bearer；HTML/API 返回 `no-store`、`no-referrer` 和 CSP；动态运行状态进入 HTML 前统一转义。
- **P0-4 已解决**：`config.json` / `auth.json` 每次写入后显式 `chmod(0600)`，包括原本为 0644 的旧文件。
- **P1-1 已解决**：GUI 用 `null` 表达清空 tunnel command/cwd，服务端把 `null` 解释为显式删除。
- **P1-2 已解决**：Control Center 拒绝空 `allowedRoots`，不再允许保存后触发隐式根目录回退。
- **P1-3 已解决**：子进程非零退出统一变成 Control Center action 失败，错误携带有界 stdout/stderr，
  HTTP 使用 422 而不是 `{ok:true, code:!=0}`。
- **P2 已重新定义**：App、DMG/ZIP、GitHub Release、安装、更新、回滚、卸载和配置保留已经实现；
  根据当前产品决策，Developer ID/notarization 不是发布阻塞项，开发签名版本通过用户首次显式允许打开即可使用。

本轮完整 `npm test`、`npm run build` 和 `git diff --check` 均通过。Capability core release 首次执行时
唯一失败项为 `runtime_source_provenance`，原因是 release gate 明确拒绝脏工作树；所有功能、性能、
容量、恢复和资源检查均通过。整改提交后应在干净 source 上重跑 core release，并以新的 `summary.json`
作为最终 release evidence。
