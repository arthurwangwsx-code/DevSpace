# 在 Lima 虚拟机中运行 DevSpace MCP

本文记录 2026-07-21 在 Apple Silicon Mac 上完成的一套最小可用配置。

## 先说结论：Lima 不是苹果官方虚拟机

Lima 是开源的 CNCF Incubating 项目，不是 Apple 开发或维护的产品。它负责创建和管理
虚拟机、共享目录与端口转发。在 macOS 13 及以上版本，Lima 默认可使用 `vz` 驱动；
这个驱动调用的是苹果官方的 `Virtualization.framework`。

可以把两者的关系理解为：

- Apple `Virtualization.framework`：苹果提供的底层虚拟化能力。
- Lima：第三方开源的命令行管理层，帮你准备 Linux 镜像、SSH、挂载和端口转发。

官方资料：

- [Lima 项目主页与项目历史](https://lima-vm.io/docs/)
- [Lima GitHub 仓库](https://github.com/lima-vm/lima)
- [`vz` 驱动说明](https://lima-vm.io/docs/config/vmtype/vz/)
- [文件系统挂载说明](https://lima-vm.io/docs/config/mount/)
- [端口转发说明](https://lima-vm.io/docs/config/port/)

## 本机已经配置好的内容

| 项目 | 当前值 |
| --- | --- |
| Lima 版本 | 2.1.1 |
| 实例名 | `devspace-mcp` |
| 客体系统 | Ubuntu 25.10 ARM64 |
| 虚拟化驱动 | `vz`（Apple Virtualization.framework） |
| 文件共享 | `virtiofs`，可读写 |
| CPU / 内存 / 磁盘 | 2 CPU / 4 GiB / 20 GiB |
| 容器运行时 | 未安装，当前测试不需要 |
| 客体 Node.js | 22.23.1 |
| MCP 客体地址 | `http://127.0.0.1:7676/mcp` |
| MCP 宿主机地址 | `http://127.0.0.1:17676/mcp` |

测试目录为：

```text
/Users/ai/project/ai-tools/devspace/lima-test-workspace
```

它在 macOS 和 Ubuntu 客体中使用相同的绝对路径。DevSpace 只允许把这个目录作为
workspace 打开；尝试打开 `/tmp` 等目录会返回 `Path is outside allowed roots`。

MCP 由虚拟机内的 systemd 用户服务 `devspace-mcp.service` 管理。服务模板保存在
`lima-test-workspace/devspace-mcp.service`。

## 日常使用

查看实例：

```bash
limactl list
```

进入虚拟机：

```bash
limactl shell devspace-mcp
```

在虚拟机内查看 MCP 服务：

```bash
systemctl --user status devspace-mcp.service
systemctl --user restart devspace-mcp.service
```

从 macOS 验证 MCP 握手：

```bash
curl -X POST http://127.0.0.1:17676/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}'
```

本地 MCP 客户端直接填写：

```text
http://127.0.0.1:17676/mcp
```

停止和再次启动：

```bash
limactl stop devspace-mcp
limactl start devspace-mcp
```

`devspace-mcp.service` 已启用，所以虚拟机启动后 MCP 会自动启动。Lima 官方的相关命令
参考见 [`shell`](https://lima-vm.io/docs/reference/limactl_shell/)、
[`stop`](https://lima-vm.io/docs/reference/limactl_stop/) 和
[`restart`](https://lima-vm.io/docs/reference/limactl_restart/)。

## 从当前源码更新虚拟机内的 DevSpace

在本仓库根目录执行：

```bash
npm run build
npm pack --pack-destination lima-test-workspace
limactl shell devspace-mcp -- sudo npm install -g --force \
  /Users/ai/project/ai-tools/devspace/lima-test-workspace/waishnav-devspace-1.0.4.tgz
limactl shell devspace-mcp -- systemctl --user restart devspace-mcp.service
rm lima-test-workspace/waishnav-devspace-1.0.4.tgz
```

这里使用当前 checkout 生成的包，而不是 npm registry 上的旧构建，因此适合验证尚未发布的
代码改动。版本号变化后，替换命令中的 tgz 文件名即可。

## 当前实例是如何创建的

以下命令用于本次创建。`--mount-only` 很重要：它避免默认共享整个用户主目录，缩小 MCP
和虚拟机能够接触到的宿主机范围。

```bash
limactl start \
  --name=devspace-mcp \
  --vm-type=vz \
  --mount-only="$PWD/lima-test-workspace:w" \
  --mount-type=virtiofs \
  --cpus=2 \
  --memory=4 \
  --disk=20 \
  --containerd=none \
  --port-forward=17676:7676,static=true \
  --yes \
  --progress
```

Lima 官方说明中，`virtiofs` 是 `vz` 在 macOS 上的默认挂载方式；静态端口规则会把
客体 localhost 服务转发到宿主机 localhost。创建参数参考
[`limactl start`](https://lima-vm.io/docs/reference/limactl_start/)。

若要修改挂载目录，可停止实例后编辑，或使用 `restart --mount-only`：

```bash
limactl stop devspace-mcp
limactl edit devspace-mcp
limactl start devspace-mcp
```

不要同时配置相互重叠的挂载路径。需要宿主机文件变更触发 Linux `inotify` 时，可以启用
`mountInotify`，但官方仍把它标为实验特性；普通读写不需要开启。

## 安全与远程连接

当前是本机测试配置：

- DevSpace 在客体内只监听 `127.0.0.1`。
- Lima 只把它转发到 macOS 的 `127.0.0.1:17676`。
- MCP 使用 `trusted-local`，不进行 OAuth 登录。
- DevSpace 的 allowlist 只有测试目录。
- `DEVSPACE_WIDGETS=off`，只验证 MCP 工具链。

因此不要直接把 `17676` 端口暴露到公网。如果以后要让 ChatGPT 云端连接，应增加 HTTPS
隧道，并根据隧道的认证边界决定是否继续使用 `trusted-local`。没有可信上游认证时，改用
DevSpace 默认 OAuth，设置强随机 Owner token，并把 `DEVSPACE_PUBLIC_BASE_URL` 改为公网
HTTPS origin。

当前 checkout 即使使用 `trusted-local`，配置加载阶段仍会解析 Owner token，所以服务文件
里放了一个仅测试用占位值；它在该模式下不用于鉴权。切换到 OAuth 时绝不能沿用这个值。

## 稳定性判断

这套组合适合持续做本机隔离测试：Apple Silicon 运行同架构 ARM Linux，使用 macOS 原生
`vz`，共享使用 `virtiofs`，MCP 走固定 localhost 端口，路径权限也已实际验证。

仍需留意：

- Lima 本身不是 Apple 官方支持的软件，但项目成熟度较高，且已进入 CNCF Incubating。
- macOS 或 Lima 大版本升级后，先检查 `limactl list`、挂载读写和 MCP 握手。
- 宿主机睡眠、网络切换后若连接异常，先重启 MCP 服务，再执行
  `limactl restart devspace-mcp`。
- `virtiofs` 适合源码与普通开发文件；依赖目录和数据库若出现文件监听或锁行为差异，可放到
  客体虚拟磁盘中，只把源码目录共享出来。
- 删除实例会删除客体系统盘及其内部配置。确认不再需要后才执行：

```bash
limactl stop devspace-mcp
limactl delete devspace-mcp
```

挂载目录位于宿主机，不会随虚拟机系统盘一起删除，但仍应提前确认路径。删除命令参考
[`limactl delete`](https://lima-vm.io/docs/reference/limactl_delete/)。

## 已完成的实测

- `devspace-mcp` 状态为 `Running`，驱动为 `vz`。
- `virtiofs` 挂载为 `rw`，客体写入后宿主机立即可见。
- systemd 服务为 `enabled` 且 `active`。
- 宿主机对 `17676/mcp` 发起 MCP initialize，返回 HTTP 200 和协议能力。
- `open_workspace` 成功打开测试目录。
- `open_workspace` 拒绝 allowlist 外的 `/tmp`。

