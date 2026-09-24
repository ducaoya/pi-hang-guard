# pi-hang-guard

给 [pi](https://pi.dev) 的命令执行看门狗：**命令停止输出时主动提醒你**，而不是让你对着一个卡死的进程干等。

pi 的 `bash` 工具默认没有超时，且只按退出码判断成败。于是「进程还活着但已经失败」的场景（dev server 编译报错、watcher 遇到语法错误、构建在等 stdin、网络请求挂起）永远等不到失败信号，pi 就一直等下去，你也不知道里面发生了什么。

本插件用**静默**作为判据来补这个缺口：它读取 pi 的流式工具事件，因此对 `bash` 能精确知道进程最后一次输出是什么时候。**静默 90 秒是真的信号，「已经跑了 90 秒」不是。**

```
⏱ bash 1m30s 无输出 · server/watch · npm run dev
```

```
bash 2m30s 无输出（超过 150s 阈值，server/watch）
命令: npm run dev
疑似卡死。当前为观察模式（observe），不会自动中断；按 Esc 手动中断。
```

## 安装

```bash
# 从 npm（发布后）
pi install npm:pi-hang-guard

# 从 git 标签
pi install git:github.com/ducaoya/pi-hang-guard@v0.1.0

# 从本地目录（开发调试，不复制源码）
pi install /absolute/path/to/pi-hang-guard

# 不安装，试用一次
pi -e /absolute/path/to/pi-hang-guard
```

也可以直接写进 `~/.pi/agent/settings.json`：

```json
{
  "packages": ["/absolute/path/to/pi-hang-guard"]
}
```

装完重启 pi，或执行 `/reload`。

卸载：

```bash
pi remove pi-hang-guard     # 或 pi remove /absolute/path/to/pi-hang-guard
```

## 用法

### 它做什么、不做什么

**v0.1.x 是纯观察模式**：只监控和提醒。不覆盖任何内置工具、不杀进程、不中断对话、不改写命令。即使它自身出错，最坏结果也只是一条错误提醒。

### 什么情况会提醒

| 情况 | 是否提醒 |
| --- | --- |
| `bash` 命令连续无输出超过阈值（默认警告 90s / 严重 150s） | ✅ |
| 非流式工具（`read`/`write`/`edit`/`grep`/`find`/`ls`）运行超过阈值（默认 180s / 600s） | ✅ |
| 已知慢命令（`docker build`、`npm ci`、`git clone`、`cargo build`…） | ✅ 阈值提高到 300s / 600s |
| 命令自带超时（`timeout 600 …`、`--timeout 30`） | ⏭️ 改按运行时长判断 |
| 一边跑一边有输出（6 分钟的构建持续打日志） | ❌ 不提醒 |
| 交互式命令（`vim`、`less`、`grep` 分页、`git rebase -i`、`git add -p`、`npm login`、`docker exec -it`、裸 `ssh`） | ⏭️ 完全不守护 |
| pi 正在等你确认（权限弹窗、选择器） | ❌ 计时冻结，不算卡死 |

### 命令

| 命令 | 作用 |
| --- | --- |
| `/guard` 或 `/guard status` | 查看正在运行的工具、阈值、配置文件路径、配置告警 |
| `/guard on` / `/guard off` | 本次会话启用 / 停用 |
| `/guard reload` | 重新读取配置文件 |

单次运行禁用：

```bash
pi --no-guard
```

## 配置

配置文件：`~/.pi/agent/hang-guard.json`（可用 `$PI_CODING_AGENT_DIR` 改目录，或用 `$PI_GUARD_CONFIG` 直接指定文件）。

**配置缺失或写坏不会影响任何工具调用**：回退到默认值并给出一条告警。

```json
{
  "enabled": true,
  "idleWarnSec": 90,
  "idleCriticalSec": 150,
  "idleWhitelistWarnSec": 300,
  "idleWhitelistCriticalSec": 600,
  "runtimeWarnSec": 180,
  "runtimeCriticalSec": 600,
  "maxNotificationsPerCall": 2,
  "showStatusBar": true,
  "notifyOnCompletion": true,
  "tickIntervalMs": 1000,
  "streamingTools": ["bash"],
  "classify": {
    "extraWatcher": ["^my-custom-server"],
    "extraInteractive": ["^psql\\b"],
    "idleWhitelist": ["slow-import"]
  }
}
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `"observe"` | 0.1.x 只支持 `observe`；其它值会告警并回退 |
| `idleWarnSec` | `90` | 静默多久给出警告 |
| `idleCriticalSec` | `150` | 静默多久给出严重提醒 |
| `idleWhitelistWarnSec` / `idleWhitelistCriticalSec` | `300` / `600` | 已知慢命令（`docker build`、`npm ci`、`git clone`…）专用的抬高阈值 |
| `runtimeWarnSec` / `runtimeCriticalSec` | `180` / `600` | 非流式工具、自带超时命令的挂钟阈值 |
| `maxNotificationsPerCall` | `2` | 每个工具调用的通知配额（设为 1 会连严重提醒一起省掉） |
| `showStatusBar` | `true` | 在底栏显示被标记工具的实时计数器 |
| `notifyOnCompletion` | `true` | 之前被提醒过的工具结束时汇报结果 |
| `tickIntervalMs` | `1000` | 重新判定的间隔 |
| `streamingTools` | `["bash"]` | 会发出流式事件的工具（静默检测只对这些生效） |
| `classify.extraWatcher` / `extraInteractive` / `idleWhitelist` | `[]` | 扩展内置清单；写错的正则会被忽略，不会报错 |

### 环境变量

优先级由低到高：默认值 → 配置文件 → `PI_WATCHDOG_*` → `PI_GUARD_*`。

| 变量 | 作用 |
| --- | --- |
| `PI_GUARD_OFF=1` / `PI_GUARD_ON=1` | 强制停用 / 启用 |
| `PI_GUARD_IDLE_WARN_MS`、`PI_GUARD_IDLE_CRITICAL_MS` | 静默阈值（毫秒） |
| `PI_GUARD_RUNTIME_WARN_MS`、`PI_GUARD_RUNTIME_CRITICAL_MS` | 挂钟阈值（毫秒） |
| `PI_GUARD_TICK_MS` | 判定间隔（毫秒） |
| `PI_GUARD_CONFIG` | 配置文件路径 |
| `PI_WATCHDOG_OFF`、`PI_WATCHDOG_WARN_MS`、`PI_WATCHDOG_CRITICAL_MS` | 旧变量名，仍然兼容 |

## 常见问题

**为什么不直接自动中断？**
自动中断（杀进程、中止本轮对话）是破坏性操作，需要分层限流和「一轮只动作一次」的保护。0.1.x 先只做可观测，把误报率降下来；自动处置在 0.2 之后。现在卡住时按 **Esc** 即可中断。

**长构建会不会被误报？**
不会。只要还在输出，静默时钟就一直在被重置，真正的静默才计数。

**装了以后没反应？**
先确认 `/guard status` 里 `mode=observe · on`。会话是在安装之前启动的话，需要 `/reload` 或重启 pi。

## 许可

MIT

> 架构、检测模型、测试策略与发布流程等实现细节见 [`AGENTS.md`](./AGENTS.md)。
