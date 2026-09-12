# MCP 并发与内存资源控制

本文说明 DevSpace 如何在高并发 MCP 客户端和 Secure MCP Tunnel 场景下保持内存有界，
以及相关配置、降载行为和验证方法。

## 背景

Streamable HTTP 客户端可能频繁重新执行 `initialize`，但不一定发送 `DELETE /mcp` 关闭旧
session。每个 session 都持有 transport、MCP server、工具定义和处理闭包。只依赖 24 小时
空闲超时会让 session 生成速度长期高于回收速度，最终触碰 Node/V8 堆上限。

一次实际高并发现场中，session 以约 811 个/小时生成，三次 OOM 都发生在约 4,200 个仍被
引用的 session 附近，V8 堆约为 4 GiB。隧道随后收到本地连接重置；隧道退出是 DevSpace
OOM 的结果，不是原因。

## 稳定性目标

资源控制遵守以下不变量：

1. 已注册 session 加正在初始化的预留槽位永远不超过硬上限。
2. 只有 `inFlight == 0` 的 session 才能被 TTL、LRU 或内存压力回收。
3. idle session 数量立即受 LRU 上限约束，不等待周期清理。
4. MCP 请求执行数和等待队列都有硬上限；无容量时返回可重试的 503，而不是继续分配。
5. 达到堆硬水位时停止接受新 initialize，但允许已有 session 的请求收尾。
6. 子进程数量、保留的 process session 数量和单进程输出缓冲都有硬上限。
7. 工作区内存对象可以休眠，但 SQLite 中的 `workspaceId` 保持有效并可透明恢复。

## 请求与 session 生命周期

新 initialize 先获取请求并发槽位，再检查内存水位，然后原子预留 session 槽位。预留在任何
异步操作前计入容量，避免并发 initialize 同时看到同一个空位。初始化成功后预留转成活跃
lease；失败则释放预留。

已有 session 的每个请求都会增加 `inFlight`。请求结束后释放 lease、刷新
`lastActivityAt`，并立即执行 idle LRU。清理器只关闭无活跃 lease 且超过 TTL 的 session。

当 session 容量已满时，registry 先关闭最老的 idle session。如果所有 session 都在活跃，
initialize 返回 HTTP 503 和 JSON-RPC `-32002`，并附带 `Retry-After: 1`。

## 对话结束、连接关闭与工作区恢复

服务端不能可靠判断用户是否“结束对话”：用户可能在同一对话中稍后继续，也可能让客户端
重连。因此生命周期分成三层，避免把共享服务一刀切地关闭：

1. MCP transport 由客户端断开或 `DELETE /mcp` 正常关闭。为了方便跨多轮对话复用，服务端
   默认保留空闲 transport，只有达到 session 容量、内存水位时才优先按 LRU 回收；另外以
   12 小时空闲 TTL 兜底清理已经失联且客户端没有正常关闭的 transport。
2. AI 不应仅因为一轮任务结束就调用 `release_workspace`。只有用户明确要求释放资源，或已知
   工作区会长期不用时才调用。它只卸载工作区的内存元数据，不停止 DevSpace、Tunnel 或
   仍在运行的命令，也不删除 checkout/worktree。
3. 即使 AI 没有显式释放，工作区元数据默认空闲 4 小时后自动休眠。原 `workspaceId` 保存在
   SQLite 中；对话继续时，下一次 `read`、`apply_patch`、`exec_command` 等调用会用同一个
   ID 自动恢复，不需要重新执行 `open_workspace`。

如果客户端丢失了 `workspaceId`，checkout 模式对同一路径再次调用 `open_workspace` 会默认
恢复最近的 active session，并返回 `resumed: true`。只有确实需要另一份独立 checkout 句柄
时才使用 `forceNew: true`；worktree 模式仍总是创建新的隔离 worktree。

这意味着“对话结束时关闭 MCP”的正确实现是关闭当前 transport 并让工作区休眠，而不是
停止共享 DevSpace/Tunnel。多个账号或多个对话可以继续复用同一后台服务。

## 内存水位

DevSpace 使用 V8 `heap_size_limit` 和 `process.memoryUsage()` 计算堆比例：

- 低于软水位：正常接收请求。
- 达到软水位：把 idle LRU 收缩到配置上限的一半，继续有限接收 initialize。
- 达到硬水位：关闭全部 idle session，并拒绝新 initialize，已有 session 仍可完成请求。

水位保护不依赖手动 GC。仍被 Map、transport 或闭包引用的对象不会因 GC 消失，提高
`--max-old-space-size` 也只能延后崩溃。

## 请求背压

2026-09-10 增加了解析前的请求体预算：MCP JSON 默认从 Express 的 100 KB 提高至
16 MiB，最多可配 64 MiB；同时以 128 MiB 预留预算限制在途 POST，默认最多 8 个。
拒绝超大请求返回明确的 413；容量满返回可重试的 503。流式文本读取最多保留 1 MiB 页，
使用返回的 `byteOffset` 续读，不因单行或整个文件很大而整文件载入内存。

`open_workspace` 的嵌套规范索引优先用有 3 秒/512 KiB 输出预算的 `rg`，缺少 `rg` 时
回退到 2 秒/20000 条目预算的扫描；最多返回 512 个候选，排除 `.build`、`.swiftpm`、
`.gradle`、DerivedData、Pods 等构建依赖目录。不扫描目录符号链接。索引是提示性列表，
可能不完整，不能据此断言子目录没有规范；编辑前仍检查目标路径上的规范文件。
同一目录并发打开合并为一个 pending 操作，避免重复扫描和创建重复句柄。

`BoundedRequestGate` 对 `/mcp` 请求使用 FIFO 并发闸门。执行槽已满时，请求进入有界队列；
队列满或等待超时都会返回 503。释放槽位会直接移交给队首请求，避免并发计数短暂降为负数或
超配。

## 命令进程和输出

`exec_command` 除了限制同时运行的子进程，还限制保留中的 process session 总数。达到总数
上限时会优先淘汰最老的已完成 session；如果全部仍在运行则拒绝新命令。

每个进程使用有界 head/tail 输出缓冲。Unicode 截断不再使用 `Array.from(string)` 展开整段
字符串，避免大输出产生字符数组级瞬时内存放大。默认 64 个 process session、每个 512 Ki
字符，使保留输出的理论预算保持有界。

全局并发之外还有 `DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE`。单个 Xcode/Gradle
工程即使持续发起命令，也不能占满其他工作区的所有执行槽。命令内部自行创建的编译线程不受
该计数直接限制，因此长期运行配置仍应保守。

工作区 `lastUsedAt` 不再在每次工具调用中同步写 SQLite。调用线程只把最新时间戳合并到
内存 Map，每秒由专用 Worker 以一个事务批量落盘；关闭服务前显式 flush。这样保持可恢复性，
同时把同步 SQLite IO 从 HTTP 事件循环移出。

## 默认配置

| 配置 | 包默认值 | AiBox 长期运行配置 |
| --- | ---: | ---: |
| 工作区内存空闲休眠 | 14400 秒（4 小时） | 14400 秒 |
| MCP session 总上限 | 512 | 512 |
| idle session 上限 | 384 | 384 |
| idle TTL | 43200 秒（12 小时兜底） | 43200 秒 |
| 清理周期 | 30 秒 | 30 秒 |
| MCP 并发请求 | 64 | 16 |
| MCP 等待队列 | 128 | 32 |
| 排队超时 | 30000 ms | 30000 ms |
| 堆软/硬水位 | 65% / 80% | 65% / 80%，V8 old-space 4 GiB |
| 并发子进程 | 16 | 4 |
| 单工作区并发子进程 | 2 | 1 |
| process session 总上限 | 64 | 32 |
| 单进程输出缓冲 | 524288 字符 | 524288 字符 |

环境变量的完整名称和调整方法见 [Configuration Reference](configuration.md)。

## 观测

服务每分钟记录一次 `resource_snapshot`，包含：

- `heapUsedMb`、`heapLimitMb`、`heapRatioPercent`、`rssMb`
- session 的 total/active/idle/reserved
- 请求的 active/queued
- process session 的 total/active
- 当前驻留内存的 workspace 数量

发生降载时记录 `mcp_overloaded`，原因可能是 `queue_full`、`queue_timeout`、
`memory_pressure` 或 `session_capacity`。session 关闭日志包含 `capacity`、`idle_limit`、
`idle_timeout`、`memory_pressure`、`transport_close` 或 `server_shutdown`。
工作区自动休眠记录为 `workspace_memory_released`；它不是工作区删除事件。

请求执行门只统计会执行 MCP 工作的 POST。Streamable HTTP 客户端长期保留的 GET/SSE
通道由 session 上限控制，不占 POST 执行槽，否则足够多的在线会话会让正常工具调用排队。
请求体的 128 MiB 总预算只是内存占用核算，不是任何形式的费用或外部 API 计费；已知
`Content-Length` 按声明大小预留，响应结束立即归还，未知长度才按单请求上限预留。

长期运行启动器关闭常规成功请求和成功工具调用日志，但仍记录慢调用、失败、过载、资源快照
和事件循环延迟。工作区活跃时间的持久化由 Worker 异步批量处理。完整的架构取舍和后续
SDK v2/stateless 基准计划见 [Performance and reliability plan](performance-and-reliability.md)。

超过阈值的 HTTP 请求和工具调用分别记录 `http_request_slow`、`tool_call_slow`；
两者可通过 `requestId` 关联。事件循环在 10 秒窗口内达到阈值时记录
`event_loop_lag`，恢复时记录 `event_loop_recovered`。默认阈值分别为 3 秒、
5 秒和 1 秒，可通过 `DEVSPACE_LOG_SLOW_REQUEST_MS`、
`DEVSPACE_LOG_SLOW_TOOL_CALL_MS`、`DEVSPACE_LOG_EVENT_LOOP_LAG_MS` 调整。

## 验证要求

修改资源控制后至少执行：

```bash
npm run typecheck
npm test
npm run build
```

单元测试包含 5,000 次 session churn，持续断言 registry 不超过 idle 硬上限；真实 HTTP 回归
还会以 16 路并发完成 512 次 MCP initialize，验证旧 session 被淘汰而最新 session 仍可用。测试还覆盖并发预留、
活跃 session 防误清、LRU、TTL、关闭失败、FIFO 队列、排队超时、内存水位、进程并发上限、
process session 总上限和大 Unicode 输出截断。

真实隧道回归应再确认：长命令在清理期间不中断、过载时客户端收到可重试错误、连续运行期间
`resource_snapshot` 中的 session 和堆占用形成平台而不是线性增长。
隔离压力与本地 Tunnel 模拟命令见 [Stress and soak testing](stress-testing.md)。
