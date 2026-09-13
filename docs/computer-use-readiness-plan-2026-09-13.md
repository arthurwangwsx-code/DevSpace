# DevSpace Computer Use 完整性、权限、稳定性与性能评估方案

日期：2026-09-13，Asia/Kuala_Lumpur（UTC+8）
状态：方案已实施；生产服务已迁移到 DevSpace 自有 LaunchAgent；macOS 系统 TCC 授权仍需用户在系统界面确认后完成最终真实桌面写操作验收。

2026-09-13 最新生产验证：`com.devspace.502.7676` 已接管 7676 服务并复用既有状态库，health
报告 release `1.0.4+7532e108c50e`。Chrome Extension 在切换后自动恢复同一 Profile。Desktop
Host 0.4.0 发布 14 项 canonical capability。权限 doctor 已改为通过 LaunchServices 探测固定 App；
该路径准确返回 Accessibility/Screen Recording 均为 false，并已发起一次集中授权请求。Terminal
直接执行 Mach-O 时出现的两项 true 属父进程 TCC 假阳性，不再作为产品就绪证据。

工程：`/Users/ai/project/ai-tools/devspace`
核查基线：`bp/master`，核查时 HEAD 为 `4d37650`；工作区存在其他任务正在修改的未提交内容。

## 1. 结论与决策

DevSpace 已有浏览器自动化和 macOS 桌面控制基础，不需要重建一套 Computer Use 平台。但目前应定位为“具备基础执行能力、尚未完成稳定部署和长期验收的版本”，不能定位为“已完整支持全天候无人值守的电脑控制产品”。

推荐沿用现有 Capability Runtime、浏览器扩展、Native Messaging、租约、监督器及 Swift Helper，补齐稳定签名的 macOS 权限宿主、精确窗口与语义动作、运行态诊断、恢复机制及真实环境性能验收。

最优先的不是增加更多点击命令，而是解决三个闭环：

1. **部署闭环**：仓库实现、安装制品、运行服务、Provider 注册和实际调用必须对应同一可追溯版本。
2. **权限闭环**：固定签名身份的 GUI 宿主实际执行受保护操作，初次集中授权，后续只做无弹窗状态检查。
3. **控制闭环**：观察具体窗口 → 获取版本化快照 → 执行动作 → 验证结果；不能只以“事件已发送”代表操作成功。

继续遵守 `AGENTS.md` 的不变约束：一级 Capability MCP API 固定为 `capability_list/search/describe/open/invoke/status/cancel/close`。所有新增桌面、浏览器、系统诊断能力都进入二级能力目录，不新增一级 `computer_*` 或 `desktop_*` 工具。

## 2. 核查范围与证据等级

本次读取了当前源码、构建脚本、已有技术文档、真实测试回执、参考项目索引；检查了运行进程和 LaunchAgent；完成了轻量健康探测、Helper 无弹窗权限预检和桌面 Provider 单元测试，并核对 GitHub 上游资料。

必须区分：源码存在、构建制品存在、服务已启用、当前实际可调用、长期验收通过。这五件事不是同一个状态。

### 2.1 本次现场结果

| 核查项 | 实际结果 | 解释与边界 |
| --- | --- | --- |
| 系统 | macOS 26.6.2 / 25G83；10 个逻辑 CPU；32 GiB 内存 | 本次远程连接的实际 Mac，不从其他设备记忆推断 |
| 主服务 | `127.0.0.1:7676/healthz` 返回 200 JSON | 仅证明进程轻量健康路径可用 |
| 健康探测 | 20/20 成功；p50 1.188 ms；p95 1.594 ms；最大 26.357 ms | 本地顺序采样，间隔约 50 ms；不是完整 MCP 或桌面端到端延迟 |
| 能力 REST 接口 | `/api/capabilities/v1/providers`、`/permissions` 均返回 404 HTML | 本次探测未能访问这两个预期接口；需核对版本、启动开关、路由及认证配置，不等于源码没有能力 |
| CLI 诊断 | `node dist/cli.js providers list --json` 报 HTML 的 JSON 解析错误 | CLI 缺少 HTTP 状态和 Content-Type 的前置诊断，底层 404 被掩盖 |
| Helper 状态 | 版本 0.2.0；`accessibilityTrusted=false`、`screenCaptureGranted=false` | 只代表此次从远程执行链启动的 `.build` 二进制；不能推断其他应用或启动链从未获授权 |
| Helper 签名 | `Signature=adhoc`；无 TeamIdentifier；designated requirement 为 cdhash | 固定 identifier 并未形成可依赖的跨构建签名身份 |
| 桌面 Provider 单测 | PASS：preset、app lease、target injection、mismatch denial | 使用测试替身验证适配与隔离，不是系统 TCC 或真实 UI 成功证明 |
| 自启动 | 主服务、隧道均已有 LaunchAgent，`RunAtLoad=true`、`KeepAlive=true`、`ProcessType=Standard`、`ThrottleInterval=10` | 已具备用户登录后的启动与退出恢复配置，未做本次重启验收 |
| 主服务资源 | 两次快照约 269–274 MiB RSS，CPU 约 0.9%–2.3% | 短暂进程快照，不是持续 CPU、泄漏或整棵进程树测量 |
| 主机压力 | 15:39:35 的 load average 为 222.34 / 132.74 / 85.33 | 说明需要控制宿主干扰；不能把 load average 解释为 CPU 百分比或直接归因于 DevSpace |
| 命令准入 | 多次遇到全局 4 个进程、每工作区 1 个进程的上限 | 真实并行任务争用与显式限流；不应通过绕过限制或盲目增大并发处理 |

本次没有重新申请权限、读取 TCC 数据库、读取签名私钥、重启主服务、锁定电脑、操作用户页面，或运行破坏性负载。

### 2.2 已有测试回执，不冒充本次重跑

| 回执 | 结果 | 可以证明什么 |
| --- | --- | --- |
| `.build/capability-stress-soak-10m-delegated-final/2026-09-13T04-40-54-345Z/summary.md` | PASS；约 10 分 28 秒；43,025/43,025 调用；5,000 次会话重连；26 项门禁通过；发现 p95 2 ms；调用 p95 23 ms；进程树峰值 RSS 603.84 MiB | 隔离 Runtime + stdio MCP 测试 Provider 的有界负载、异常归一、取消、恢复和清理；不覆盖真实 Chrome/TCC/桌面 |
| `.build/browser-extension-matrix/2026-09-13T07-26-36-245Z/summary.md` | FAIL；解锁基线正常，锁屏时 snapshot/screenshot 成功；解锁恢复等待重连 120,227.51 ms 后失败 | 曾出现真实扩展恢复问题。之后 15:36 的 `4d37650` 已提交相关修复，但本次检查未发现更新的完整 PASS 回执，不能宣布闭环，也不能断言修复后必然仍失败 |
| `.build/desktop-lock-boundary/2026-09-13T07-14-50-644Z/summary.md` | PASS；锁屏时 status 允许、桌面动作及 app lease 拒绝 | 安全边界有效，不代表锁屏桌面可操作 |

浏览器回执中的部分动作耗时数秒，例如截图约 2.83 秒、部分点击/聚焦约 5 秒；它们包含真实浏览器与环境等待，不应与 Runtime 测试替身的 23 ms 作直接性能比较。

## 3. 现有能力盘点

### 3.1 已有浏览器基础

`browser-extension/`、`native-host/` 和 `src/capabilities/providers/` 已实现扩展连接现有 Chrome Profile 的路线。源码和项目文档覆盖标签页发现、创建、接管、释放，页面快照、HTML、截图，导航、点击、滚动、输入、按键、等待，以及控制台、网络、性能、下载和上传等能力。

已有用户标签页、临时接管标签页和 Agent 标签页的所有权区分；释放用户标签页不应关闭页面。Native Messaging 与 Unix socket 承担本机桥接。普通页面自动化与深度调试后端分层，不需要把所有动作都变成桌面坐标点击。

当前工作区正在收口 `browser.control` 及 `browser.tab.*`、`browser.page.*` 等二级规范名称。继续复用这套方向，避免另建平行浏览器协议。具体制品部署就绪仍受第 2 节运行态检查约束。

### 3.2 已有八项 macOS 桌面能力

实现位于 `src/capabilities/providers/macos-desktop-provider.ts` 与 `native/desktop-helper/main.swift`。

| 二级能力 | 现有行为 |
| --- | --- |
| `desktop.macos.status` | 查询 AX、屏幕捕获预检、进程和用户活跃状态 |
| `desktop.macos.list_apps` | 列举正在运行的 GUI 应用 |
| `desktop.macos.snapshot_app` | 有深度、节点数量和部分字段长度边界的 AX 树；不返回安全输入框的 value |
| `desktop.macos.screenshot_app` | 捕获目标应用面积最大的可见窗口，缩放并返回 PNG |
| `desktop.macos.activate_app` | 激活租约对应应用 |
| `desktop.macos.click_point` | 在目标应用位于前台时执行左键坐标点击 |
| `desktop.macos.type_text` | 验证焦点属于目标进程后输入文本 |
| `desktop.macos.press_key` | Return、Tab、Space、Delete、Escape 和方向键 |

已有应用目标注入、禁止调用参数替换租约目标、Provider 内调用串行化、用户操作时让出控制、锁屏拒绝等保护。在默认 delegated-approval 模式下，DevSpace 不重复增加一套逐动作 Grant 流程；上层 Agent 的审批和系统权限仍各自独立。

### 3.3 主要缺口

| 缺口 | 当前证据 | 建设要求 |
| --- | --- | --- |
| 精确窗口身份 | 名为 `app_window` 的租约实际仅保存 bundleId | 增加 PID/进程世代、windowId、窗口身份与失效检测；禁止应用重启后静默复用旧目标 |
| 截图到点击的坐标协议 | 截图返回缩放后 width/height 和 windowId，但没有窗口桌面原点、完整坐标变换；点击使用全局坐标 | 统一 frame、displayId、逻辑点/图片像素、比例与变换；布局变化后拒绝旧快照 |
| 语义动作 | AX 树有角色、文字、位置，但没有可操作的版本化 element handle | 增加 snapshotId + elementId；公开 AX action 优先，坐标兜底 |
| 常用交互 | 缺少桌面滚动、拖拽、右键/双击、组合键、明确窗口选择等 | 扩展二级能力与参数约束，并使用本地 fixture 验证，不开放任意底层事件透传 |
| 多调用者争抢 | 已有逐调用串行，但不是完整交互序列的前台独占 | Broker 统一前台交互调度；有界短租约；用户输入优先；跨客户端不穿插敏感序列 |
| 结果验证 | 多数输入操作返回的是事件已发送 | 增加焦点/状态后置条件，明确 executed、verified、outcome_unknown；失败不盲目重放非幂等操作 |
| 发布与权限宿主 | `.build` 裸 Helper + ad-hoc 签名 | 稳定签名 App/Broker、正式安装位置、集中权限页、升级和回滚 |
| 长期运行验收 | 现有主要是有界测试与 10 分钟隔离 soak | 真实 Provider、重启/休眠/锁屏矩阵与 24 小时验收 |

## 4. GitHub 与本地参考选型

参考目录已有八个上游快照，第三方源码是只读研究材料，不等于已集成为运行时能力。以下提交号由本机 Git 元数据核对，不是对上游最新提交的承诺。

| 工程 | 本地情况 | 本方案用途 |
| --- | --- | --- |
| QwenLM/open-computer-use | `参考工程/qwen-open-computer-use`，`f238d1b` | 语义 UI、快照作用域、图片缩放坐标换算、权限引导和真实 fixture 测试的重点参考 [W1] |
| CursorTouch/MacOS-MCP | `参考工程/macos-mcp`，`a7e135c` | AX/窗口操作与 launchd 安装诊断参考；不直接把通用解释器授权链作为最终产品路线 [W2] |
| munimtechnologies/munim-computer-use | `参考工程/munim-computer-use`，`4cf64d0` | 已登录 Chrome、Native Messaging、桌面与浏览器组合参考 [W3] |
| ChromeDevTools/chrome-devtools-mcp | `参考工程/chrome-devtools-mcp`，`d9a8cb6` | 深度浏览器调试与持久连接；不替代桌面权限宿主 |
| microsoft/playwright-mcp | `参考工程/playwright-mcp`，`8a13ef8` | 浏览器上下文、扩展模式与行为契约 |
| openclaw/Peekaboo | 本次新增在线调研；未在现有参考目录发现 | 签名 GUI Bridge、权限归属、窗口目标与诊断是重点补充参考 [W4][W5] |

此外已有 Docker MCP Gateway、MCP Gateway Registry 和官方 MCP Registry，继续作为能力目录、进程池与稳定元 API 的参考，不需要为 Computer Use 再引入整套网关。

**选型建议：现有 Swift Helper 自主演进，Qwen 参考动作与快照，Peekaboo 参考权限宿主和产品化，现有扩展继续负责网页。** 不建议同时常驻挂载多个桌面控制后端，让不同进程各自申请权限、占用焦点和维护状态。新增参考快照应另行固定提交并记录许可，不在本次评估中改动已有锁文件。

## 5. 目标架构：稳定 API + 稳定权限宿主

```text
远程 Agent / MCP 客户端
          |
固定八个 Capability MCP 工具
          |
DevSpace Capability Runtime
  目录 / 策略 / 租约 / 审计 / 限流 / 状态
          |
          +-- Browser Provider
          |     扩展 + Native Messaging；必要时使用既有深度调试后端
          |
          +-- Desktop Provider / 本机桥接客户端
                  |
              经过身份验证的本机 IPC
                  |
              DevSpace.app 内的 Desktop Broker
              稳定签名，运行于已登录用户 GUI 会话
                  |
              公共 AX API / ScreenCaptureKit / CGEvent
```

App 并非另一个执行任务的 AI Agent：它只提供状态页、权限引导、开机/登录配置和受控原子操作。任务规划继续由上层 Agent 完成，避免重复模型循环与额外模型费用。

Broker 必须实际执行截图、AX 和输入操作；仅给 Node 套一个 App 外壳、随后仍从临时 shell 执行裸二进制，不能视为权限归属问题已解决。[W4][W5]

IPC 首选可验证调用方身份的本机机制；实施时在 XPC 与当前 Unix socket 兼容路线之间验证。校验当前用户、调用方代码签名/指定要求、协议版本和能力范围，不只凭一个可连接的 socket 路径授权。高权限 Broker 不暴露任意 shell、原始 CDP 或任意本机函数执行。

路由优先级是明确的：已有 API/CLI → 浏览器语义操作 → 桌面 AX → 经许可的截图坐标兜底。浏览器失败不能无告知地切换为会抢占桌面焦点的操作。

### 5.1 建议目录与兼容策略

```text
native/
  desktop-helper/           保留现有入口，迁移期间兼容
  desktop-core/             拟抽取公共 AX、捕获、输入、窗口和快照逻辑
  macos-companion/          拟新增 DevSpace.app、权限页与 Desktop Broker
src/capabilities/
  providers/               继续使用现有 Provider 注册与适配机制
  desktop/                 拟增加坐标协议、交互调度、恢复契约
scripts/macos/             拟增加打包、安装、诊断、升级与卸载
test-fixtures/desktop/     拟扩展多窗口、滚动、拖拽、菜单和安全输入 fixture
docs/                     技术方案、签名部署手册、验收回执索引
```

上述新增目录和名称是实施建议，不是已建成的文件。二级能力可逐步收口到 `desktop.window.*`、`desktop.element.*` 等语义名称，但必须保留当前 `desktop.macos.*` 的兼容映射及测试，不趁迁移破坏现有调用。

## 6. 权限：减少重复，不承诺绕过系统

### 6.1 区分四层权限

| 层级 | 管理方 | 方案 |
| --- | --- | --- |
| macOS AX、屏幕捕获等 | 操作系统 | 授予固定签名且真正执行操作的 App/Broker |
| Chrome 扩展与调试器提示 | 浏览器 | 稳定扩展 ID、一次安装引导、明确浏览器自身提示边界 |
| DevSpace 策略与租约 | 本工程 | 延续 delegated-approval，避免无意义的第二次审批；保留资源所有权隔离 |
| 上层 Agent 的动作确认 | MCP 宿主/客户端 | 不能由 DevSpace 私自替客户端取消；与 macOS 弹窗分开诊断 |

### 6.2 推荐实现

安装到固定位置，例如 `/Applications/DevSpace.app`，维护稳定 Bundle ID、Developer ID 签名团队和经过验证的 designated requirement。发布前验证签名与更新身份，正式对外分发再完成相应公证流程。当前 Helper 的 ad-hoc/cdhash 方式不作为稳定升级基线。[W6]

初次打开 App 时集中展示 Accessibility 与 Screen Recording 授权项；只有实际需要时才增加额外权限。不把完全磁盘访问、输入监听、麦克风或全局 Apple Events 作为默认套餐，也不要求给所有 Terminal、Node、Python 分别授权。

常规启动、服务重连、每次调用只执行无弹窗预检。状态区分 ready、needs_permission、waiting_for_login、locked、disconnected、degraded；权限缺失时上报原因和安装身份，不反复弹系统设置、不通过重启循环“修复”权限。只有用户主动进入权限引导才触发授权流程。

发布需要本机可用的稳定签名身份。本次未读取私钥，也未确认已经具备相应 Developer ID 证书；不能把“Apple ID 已登录”自动当作这一前提满足。

### 6.3 必须明确的边界

“一次集中授权后，正常运行和兼容更新不再反复打扰”是工程目标，不是“永久无任何系统确认”的保证。更换签名团队、改变执行主体、系统策略变化或用户撤销权限都可能需要重新处理。Peekaboo 的上游文档明确记录：Bundle ID 不变但更换签名团队后，仍需重新授予 TCC 权限。[W4]

Apple 的持久屏幕捕获 entitlement 面向特定 VNC 场景且需要申请，不能把获批或适用于本项目当作前提。[W7] 也不使用自动点击权限面板、修改 TCC 数据库、关闭系统保护等方式实现“无人值守”。

## 7. 自启动与稳定性

### 7.1 保留已有效的部分

现有主服务和隧道已经由两个 LaunchAgent 管理。应先审计和迁移，而不是再注册第三套重复服务。当前启动链依赖 AiBox 的 `docs/mcp/devspace/launch-agent-runtime.sh`、nvm 具体 Node 路径与全局 npm CLI，这些是产品独立升级与远程恢复的风险点。

建议由 DevSpace 自己拥有发布制品、安装器、稳定运行目录和服务配置；AiBox 只保留兼容入口。先完成版本与配置迁移，再逐步脱离兄弟仓库的源码路径。迁移必须可回滚，旧服务停止与新服务切换不能留下双实例争抢端口或浏览器 socket。

新增 macOS App 采用受系统管理的登录项方案，评估 `SMAppService`；GUI Broker 运行在目标用户的 GUI 会话中。[W8][W9] 不把 root LaunchDaemon 当作绕过桌面会话权限的捷径。

### 7.2 三个状态必须分别报告

| 状态 | 含义 |
| --- | --- |
| 服务在线 | 网关和隧道可达，不代表屏幕可见或 UI 可操作 |
| 用户已登录 | GUI 会话存在；仍可能锁屏或权限不足 |
| 桌面可操作 | GUI 会话、未锁屏、权限、目标窗口和交互租约均满足 |

LaunchAgent 的登录启动，不等于冷启动后无需任何人登录。FileVault 开启时，Apple 明确要求手动登录，不能承诺断电重启后自动进入可操控桌面。[W10] 本次没有检查这台 Mac 的 FileVault 配置。

桌面锁屏时暂停 UI 写操作，保留可读的状态诊断；解锁后重新验证窗口世代和快照。浏览器后台协议在锁屏时是否可继续，以完整同连接转换矩阵验收为准，不从一次截图成功推广到所有能力。休眠、显示器熄屏、会话锁定、退出登录分别测试，不能混为一类。

确需任务期间保持唤醒时，使用有期限、结束即释放的系统电源断言，并提供明确开关；不默认永久保持显示器亮起或关闭安全锁屏。

### 7.3 恢复与可观测性

监督关系保持单一：launchd 管外层服务；Runtime 管普通 Provider 子进程；GUI Broker 由自己的登录服务管理。避免互相重复重启。真实退出采用有上限的指数退避；权限不足、未登录和锁屏属于状态降级，不属于应不断重启的崩溃。

Extension/Native Host/Runtime 断连后，采用带抖动退避、会话 epoch、过期请求终止和 ownership 重校验。禁止超时后静默重放“点击支付”“发送消息”等非幂等动作；结果不确定时先观察并报告 outcome_unknown。

健康诊断增加分层结果：本地进程、Provider、权限宿主、扩展连接、隧道控制链、MCP initialize/list、真实只读能力。CLI 遇到 HTTP 404 或非 JSON 时给出明确的 disabled/version/config 诊断，不再抛原始 JSON 解析异常。

运行态暴露 releaseId、sourceCommit、buildTime、配置摘要哈希与协议版本，解决“仓库代码已完成，线上仍跑旧入口”的不可见问题。日志只保存错误码、时延、资源量和必要目标元数据，不保存密码、完整网页、命令正文或默认长期留存截图。

## 8. 性能结论与测量方案

### 8.1 当前可以和不可以下的结论

可以确认：轻量本地健康路径响应快；已有隔离 Capability 压测结果良好；主机同时承受极高压力；真实浏览器链路曾有数秒动作和恢复超时。

不能确认：功能扩展前后“完全没有退化”，或“所有卡顿都是 DevSpace 新功能导致”。没有在同一制品、主机压力、配置、输入和工作负载条件下完成旧版/新版对照；也没有完成本次 24 小时真实 Provider soak。

因此优先做分层观测和发布对齐，不先更换 Express、不先重写 Node 网关，也不盲目加大堆和并发上限。

### 8.2 已有资产与潜在热点

现有文档与测试记录已覆盖请求/进程配额、会话保留上限、后台 SQLite 写入、日志轮转、取消、Provider 恢复和无孤儿进程验证。这些机制应保留。[E5][E6]

桌面实现需重点测量以下热点，而不是先假设已经发生退化：AX 同步读取和坏窗口超时；整棵树重复序列化；每次截图重新枚举窗口、编码 PNG 和 base64；单 Provider 串行操作的队头阻塞；截图两个阶段各有 15 秒内部等待而默认 Provider 超时为 15 秒的预算协调。

当前截图限制为 2,500,000 原始 PNG 字节，base64 会扩大约三分之一；需要同时设置编码后响应预算。优先语义快照、区域截图、可配置缩放、事件驱动缓存及有界保留；没有请求时不持续录屏、不忙轮询。不要因“常驻”而默认高频捕获屏幕。

### 8.3 可复现对照矩阵

| 维度 | 实验设计 |
| --- | --- |
| 构建 | 固定可追溯的旧版、当前版、加固版制品；不使用正在变化的 dirty checkout 作性能对照 |
| Provider | workspace-only、启用但空闲、仅 browser、仅 desktop、两者混合 |
| 主机压力 | 低负载与明确记录的 Xcode/Gradle 并行负载分别运行 |
| 传输 | 本机直接、经本地 tunnel、实际远程 MCP 分开统计 |
| 工作负载 | 冷启动、连接/重连、discover、AX、截图、动作+验证、超时和取消 |
| 资源 | Core/Broker/Native Host 的 RSS、CPU、事件循环延迟、FD、线程/子进程数、队列等待、日志与截图保留 |
| 用户体验 | 权限弹窗次数、误抢焦点次数、需要人工 reload 次数、错误恢复后任务成功率 |

报告至少给出 p50/p95/p99、错误分类、样本量和环境指纹。模型推理时间、网络时间、排队时间与本机执行时间分别计算，不把它们揉成一个“Computer Use 性能”。

已有 Runtime 门禁可继续用：发现 p95 <100 ms、测试 Provider 调用 p95 <150 ms、相同测试进程树峰值 RSS <1 GiB、意外错误为零。上述 150 ms 不适用于真实截图或 GUI 动作。桌面原生时延先采样建立基线，再设绝对预算和同条件 p95 回归阈值；建议重复实验确认后把超过 20% 的变化列为回归调查项，而不是用单次波动判失败。

## 9. 分阶段实施与验收

下面是建议的待实施工作，不是本次已完成事项。

| 阶段 | 交付内容 | 必须验收 |
| --- | --- | --- |
| P0-A 部署可见性 | releaseId/运行版本、能力接口启用诊断、非 JSON 错误归一、现有恢复修复复测 | 正式服务可发现并调用状态能力；不再以 healthz 200 代替完整可用；同连接解锁/锁屏/恢复矩阵产生新 PASS 回执 |
| P0-B 稳定权限与启动 | 签名 DevSpace.app/Broker、集中授权页、只读 doctor、独立安装/升级/回滚、登录服务 | 初次授权后普通重启不触发工程自身的重复申请；授权拒绝不重启风暴；远程实际链路能捕获 fixture 并读取 AX |
| P1 完整交互闭环 | 精确窗口、snapshot/element handle、坐标转换、常用交互、短期独占与后置验证 | 多窗口、多显示器、缩放、窗口移动、目标重启、用户抢回控制和两个 Agent 交错全部有测试 |
| P2 长期稳定与性能 | 固定制品 A/B、分层指标、断连/崩溃/升级矩阵、真实 fixture soak | Runtime 与真实 Provider 分别通过；24 小时 direct/tunnel 测试；无异常权限弹窗循环、失控子进程或持续资源增长 |
| P3 可选扩展 | 特定应用适配、受控剪贴板/跨应用流程、独立自动化桌面环境 | 根据实际任务成功率决定，不抢占前述稳定性工作的优先级 |

建议验收样本：同一已签名制品重启 100 次；同一签名身份兼容升级 3 次；至少 20 次锁屏转换、10 次扩展/Helper 恢复演练；24 小时作为正式持续运行门禁，72 小时作为后续增强。记录操作系统自身要求的重新确认，与 DevSpace 的意外重复提示分开归因。这些次数是验收建议，本次没有执行。

真实 UI 压测只针对专用本地 fixture 与 Agent 自建页面，不对已登录业务系统做写入负载。冷启动、锁屏、休眠、签名升级等会影响当前远程连接的测试，要安排有恢复路径的验收窗口，不在评估中突袭执行。

若未来要求与日常使用完全不争抢桌面，可另行评估专用 Mac 或隔离桌面环境；这解决的是会话与资源隔离，不是对 FileVault、登录窗口和 TCC 的绕过。

## 10. 本次交付与未完成事项

已完成：代码/文档与参考目录核查、GitHub 调研、现场只读诊断、桌面 Provider 单元测试，以及本方案。

未完成且不宣称完成：稳定签名 App 的开发与安装、正式能力服务部署对齐、系统授权、当前修复后的完整浏览器转换矩阵、真实桌面动作全面验收、旧版/新版性能 A/B、24/72 小时 soak、重启/休眠验收。

评估阶段只新增了本文档；随后实施阶段按下节记录完成代码、签名 Host、Provider 热更新与服务生命周期建设。

## 11. 2026-09-13 实施结果

本方案随后已在隔离 worktree 中实施并合并回 `bp/master`，对应提交为：

- `6d17229` `feat(desktop): complete semantic computer use controls`
- `68769dd` `feat(macos): own devspace service lifecycle`
- `5e9d664` `fix(desktop): launch provider with stable TCC identity`
- `2c1c8e6` `fix(desktop): refresh long-lived app state`
- `2abb424` `fix(desktop): type through focused accessibility field`
- `ad496b9` `test(desktop): accept synchronous lease expiry`
- `901ca74` `fix(desktop): make fixture mutations deterministic`

已落地的 Computer Use 能力包括：精确窗口枚举与指定窗口截图、带短期
`snapshotId` / `elementId` 的 AX 语义元素、语义点击和聚焦、滚动、拖拽、左/右键与
双击参数、受控组合键、应用进程世代校验以及短期快照失效机制。桌面 Host 已升级为
`0.4.0`，以原有 `J56BFQN5PZ` 团队签名安装到固定路径，并已将 14 项桌面二级能力通过
动态 Provider 管理接口加载到正在运行的 Capability Runtime；一级 MCP API 仍保持固定八
工具不变。

权限流程已改成两条明确路径：正常启动与健康检查只做无弹窗 preflight；只有显式运行
`--request-permissions` 才请求系统显示 Accessibility / Screen Recording 授权 UI。随后使用
已获得 Accessibility 的稳定签名 Host 通过公开 AX 接口完成系统设置中的 Screen Recording
开关操作，没有修改 TCC 数据库、关闭 SIP 或使用安全机制绕过。当前正式
`DevSpaceDesktopHost.app` 以 `J56BFQN5PZ` 团队和固定 bundle id
`com.devspace.desktop-host` 安装，版本 `0.4.4`，LaunchServices 身份探测返回
`accessibilityTrusted=true`、`screenCaptureGranted=true`。

实施过程中还确认了一个关键 TCC 身份问题：Runtime 直接 spawn App Bundle 内 Mach-O 时，
macOS 会把权限责任归属到错误的启动链，导致正式 App 已授权而 Provider 仍得到 false。
现已增加 LaunchServices stdio bridge，让 MCP Provider 通过签名 App 身份启动并继续透传
stdin/stdout；Provider 热重载后状态为 `ready`，14 项桌面 capability 均使用该稳定身份。

另外修复了长生命周期 Helper 的 GUI App 发现刷新、租约注入字段对外 schema、聚焦文本框
输入，以及 fixture `NSButton.target` 不被强持有导致 `AXPress` 返回成功但 action 未执行的问题。
`desktop_click_element` 现在不会把 AXPress 的“动作已派发”错误标记成业务结果已验证；真正的
业务结果由后续 snapshot/postcondition 验证。

DevSpace 现已自带 macOS LaunchAgent 安装器、watchdog 与 doctor，可将服务运行逻辑从兄弟
仓库迁移到 `~/Library/Application Support/DevSpace/runtime`，记录 release/source commit，
并区分“已安装版本”和“当前正在运行版本”。安装配置不内嵌 owner token、隧道 API key 等
秘密；立即切换由显式 `--activate` 控制，以免安装过程意外断开当前远程会话。

最终验证结果：完整 `npm test` 与 `npm run build` 均通过；桌面 Provider 实机只读性能门禁通过，
REST `desktop_status` p95 为 44 ms、MCP p95 为 48 ms，测试期间 RSS 增长 928 KiB；clean
commit 的 Capability smoke 80/80 业务调用成功、invocation p95 26 ms、进程树峰值 RSS
356.97 MiB、全部 release gates 通过且无孤儿 Provider。

真实生产路径验收也已闭环：`npm run test:desktop-runtime-fixture` 使用固定签名 0.4.4 Host、
正式 Capability Runtime/REST、真实 TCC、真实 AX 和窗口截图完成 22/22 PASS。覆盖权限门、
Fixture 启动、进程绑定租约、应用激活、AX snapshot、窗口枚举、应用/精确窗口截图、语义点击
及后置验证、语义聚焦、Command+A、文本输入、允许按键、滚动、拖拽、文本后置验证、应用重启、
旧租约 `lease_expired` 以及恢复租约。最终回执：
`.build/desktop-runtime-fixture/2026-09-13T11-12-06-018Z/summary.md`。

临时 ad-hoc Helper 的 `test:desktop-helper` 不再把终端继承的 TCC 当作产品权限证据：没有稳定
TCC 身份时只验证 MCP 协议、14 项工具和 schema，并明确跳过真实 AX/screenshot canary；真实
桌面动作只由上述生产 signed Host fixture 负责验收。

## 附录 A：本地证据索引

- [E1] `AGENTS.md`：固定一级 API、workspace 与远程访问约束。
- [E2] `src/capabilities/providers/macos-desktop-provider.ts`：8 项映射、bundleId lease、调用串行与参数隔离。
- [E3] `native/desktop-helper/main.swift`：94–221 行动作及预检；239–325 行截图与超时；328–412 行窗口、焦点与 AX 树。
- [E4] `scripts/build-desktop-helper.sh`；`docs/macos-desktop-helper.md`：ad-hoc 构建、正式签名建议与能力边界。
- [E5] `docs/performance-and-reliability.md`：现有资源控制、历史 workspace 压测和剩余实验。
- [E6] `docs/capability-stress-testing.md` 及第 2.2 节三个真实回执路径：隔离 Runtime 与真实 Provider 的分开验收。
- [E7] `docs/browser-extension-architecture.md`：扩展、Native Messaging、所有权、能力范围与演进方向。
- [E8] `src/cli.ts` 的 `capabilityFetch`（核查时约 733 行）、`src/server.ts` 的 capability REST 挂载：HTTP 404 与 JSON 解析诊断。
- [E9] `参考工程/README.md`、各引用仓库的 `git remote`/`git log -1`：本地参考来源及固定快照。
- [E10] 现场工具输出：`sw_vers`、`sysctl`、`uptime`、选定字段的 LaunchAgent plist、`launchctl print`、`ps`、本地 HTTP 探测、`codesign -d -r-`、Helper `desktop_status`。
- [E11] 本次执行 `node --import tsx src/capabilities/providers/macos-desktop-provider.test.ts`，输出 `macOS desktop provider tests passed: preset, app lease, target injection and mismatch denial`。

行号对应核查瞬间的工作区，后续并行修改可能使行号变化；应同时按函数名定位。历史回执没有被本次修改。

## 附录 B：上游资料

检索日期均为 2026-09-13。上游动态页面用于方案依据，不代表其最新代码已安装到本机。

- [W1] Qwen Open Computer Use：<https://github.com/QwenLM/open-computer-use>
- [W2] CursorTouch MacOS-MCP：<https://github.com/CursorTouch/MacOS-MCP>
- [W3] Munim Computer Use：<https://github.com/munimtechnologies/munim-computer-use>
- [W4] Peekaboo 权限、签名迁移与后台启动边界：<https://github.com/openclaw/Peekaboo/blob/main/docs/permissions.md>
- [W5] OpenClaw Peekaboo Bridge：<https://docs.openclaw.ai/platforms/mac/peekaboo>
- [W6] Apple TN3127，Code Signing Requirements：<https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements>
- [W7] Apple Persistent Content Capture：<https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture>
- [W8] Apple SMAppService：<https://developer.apple.com/documentation/servicemanagement/smappservice>
- [W9] Apple TN2083，Daemons and Agents：<https://developer.apple.com/library/archive/technotes/tn2083/_index.html>。仅用于系统/用户 GUI 会话的架构边界，不照搬其中过时的安装 API。
- [W10] Apple 自动登录与 FileVault 边界：<https://support.apple.com/en-ae/102316>
