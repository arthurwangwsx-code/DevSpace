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

## 请求与 session 生命周期

新 initialize 先获取请求并发槽位，再检查内存水位，然后原子预留 session 槽位。预留在任何
异步操作前计入容量，避免并发 initialize 同时看到同一个空位。初始化成功后预留转成活跃
lease；失败则释放预留。

已有 session 的每个请求都会增加 `inFlight`。请求结束后释放 lease、刷新
`lastActivityAt`，并立即执行 idle LRU。清理器只关闭无活跃 lease 且超过 TTL 的 session。

当 session 容量已满时，registry 先关闭最老的 idle session。如果所有 session 都在活跃，
initialize 返回 HTTP 503 和 JSON-RPC `-32002`，并附带 `Retry-After: 1`。

## 内存水位

DevSpace 使用 V8 `heap_size_limit` 和 `process.memoryUsage()` 计算堆比例：

- 低于软水位：正常接收请求。
- 达到软水位：把 idle LRU 收缩到配置上限的一半，继续有限接收 initialize。
- 达到硬水位：关闭全部 idle session，并拒绝新 initialize，已有 session 仍可完成请求。

水位保护不依赖手动 GC。仍被 Map、transport 或闭包引用的对象不会因 GC 消失，提高
`--max-old-space-size` 也只能延后崩溃。

## 请求背压

`BoundedRequestGate` 对 `/mcp` 请求使用 FIFO 并发闸门。执行槽已满时，请求进入有界队列；
队列满或等待超时都会返回 503。释放槽位会直接移交给队首请求，避免并发计数短暂降为负数或
超配。

## 命令进程和输出

`exec_command` 除了限制同时运行的子进程，还限制保留中的 process session 总数。达到总数
上限时会优先淘汰最老的已完成 session；如果全部仍在运行则拒绝新命令。

每个进程使用有界 head/tail 输出缓冲。Unicode 截断不再使用 `Array.from(string)` 展开整段
字符串，避免大输出产生字符数组级瞬时内存放大。默认 64 个 process session、每个 512 Ki
字符，使保留输出的理论预算保持有界。

## 默认配置

| 配置 | 默认值 |
| --- | ---: |
| MCP session 总上限 | 256 |
| idle session 上限 | 128 |
| idle TTL | 600 秒 |
| 清理周期 | 30 秒 |
| MCP 并发请求 | 64 |
| MCP 等待队列 | 128 |
| 排队超时 | 30000 ms |
| 堆软/硬水位 | 60% / 75% |
| 并发子进程 | 16 |
| process session 总上限 | 64 |
| 单进程输出缓冲 | 524288 字符 |

环境变量的完整名称和调整方法见 [Configuration Reference](configuration.md)。

## 观测

服务每分钟记录一次 `resource_snapshot`，包含：

- `heapUsedMb`、`heapLimitMb`、`heapRatioPercent`、`rssMb`
- session 的 total/active/idle/reserved
- 请求的 active/queued
- process session 的 total/active

发生降载时记录 `mcp_overloaded`，原因可能是 `queue_full`、`queue_timeout`、
`memory_pressure` 或 `session_capacity`。session 关闭日志包含 `capacity`、`idle_limit`、
`idle_timeout`、`memory_pressure`、`transport_close` 或 `server_shutdown`。

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
