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
| `/guard` 或 `/guard status` | 查看模式、正在运行的工具、阈值、已执行的动作、配置文件路径、配置告警 |
| `/guard on` / `/guard off` | 本次会话启用 / 停用 |
| `/guard reload` | 重新读取配置文件 |

单次运行禁用：

```bash
pi --no-guard
```

### 自动处置（0.2 起，默认关闭）

默认是**纯观察**（`mode: "observe"`），只提醒不动手。开启后，静默超过**严重阈值**时按模式处置：

| mode | 严重阈值到达后 | 对话是否继续 |
| --- | --- | --- |
| `observe`（默认） | 只提醒 | 继续等待 |
| **`guard`（推荐）** | 中止本轮对话（`ctx.abort()`） | 否，但会自动开新一轮把**结构化报告**交给模型继续处理 |
| `yolo` | 先尝试杀掉已登记的子进程；不行或宽限期过后再中止对话 | 软杀成功则继续；否则同 `guard` |

开启方式（任选）：

```bash
# 一次性
PI_GUARD_MODE=guard pi

# 持久化
```

```json
{ "mode": "guard" }
```

**自动续跑的护栏**（不会失控）：

- 每会话最多 `maxAutoResumes`（默认 1）次
- 两次动作之间至少间隔 `actionCooldownSec`（默认 60s）
- 同一个工具只处置一次
- 只有**我们自己发起**的中断才会续跑；你按 **Esc** 中止的绝不续跑
- `-p` / `--mode json` 等无 UI 模式默认不续跑（`resumeWithoutUI` 可开）

**报告长这样**（模型据此继续）：

```
[pi-hang-guard] 已自动处置一个疑似卡死的命令
动作: 中止本轮对话（第 1/1 次自动续跑，mode=guard）
原因: bash 3m12s 无输出（超过 150s 阈值，server/watch）
命令: npm run dev
已收集的输出尾部:
…
请继续处理：先判断该命令是在等待输入、网络挂起，还是本身就是 dev/watch 服务；
若是服务类命令，改用后台运行并轮询日志，不要在前台阻塞。
```

> **关于 `yolo` 的能力边界**：软杀依赖 pi 的内部进程注册表，而官方安装的 pi 是**打包构建**（`bin` 指向 `dist/bundle/cli.js`，chunk 不导出任何东西），此时那个注册表是一份私有副本，杀不动任何进程。插件会**主动探测**这种情况并直接降级为中止对话（报告里会写明原因），**不会假称软杀成功**。只有从源码运行 pi 时软杀才真正生效。

## 配置

配置文件：`~/.pi/agent/hang-guard.json`（可用 `$PI_CODING_AGENT_DIR` 改目录，或用 `$PI_GUARD_CONFIG` 直接指定文件）。

**配置缺失或写坏不会影响任何工具调用**：回退到默认值并给出一条告警。

```json
{
  "enabled": true,
  "mode": "observe",
  "idleWarnSec": 90,
  "idleCriticalSec": 150,
  "idleWhitelistWarnSec": 300,
  "idleWhitelistCriticalSec": 600,
  "runtimeWarnSec": 180,
  "runtimeCriticalSec": 600,
  "maxNotificationsPerCall": 2,
  "softKillGraceSec": 15,
  "maxAutoResumes": 1,
  "actionCooldownSec": 60,
  "resumeWithoutUI": false,
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
| `mode` | `"observe"` | `observe` / `guard` / `yolo`，见上节 |
| `idleWarnSec` | `90` | 静默多久给出警告 |
| `idleCriticalSec` | `150` | 静默多久给出严重提醒（也是触发处置的阈值） |
| `idleWhitelistWarnSec` / `idleWhitelistCriticalSec` | `300` / `600` | 已知慢命令（`docker build`、`npm ci`、`git clone`…）专用的抬高阈值 |
| `runtimeWarnSec` / `runtimeCriticalSec` | `180` / `600` | 非流式工具、自带超时命令的挂钟阈值 |
| `maxNotificationsPerCall` | `2` | 每个工具调用的通知配额（设为 1 会连严重提醒一起省掉） |
| `softKillGraceSec` | `15` | `yolo` 下软杀后等多久才升级为中止对话 |
| `maxAutoResumes` | `1` | 每会话最多自动续跑几次（`0` = 只中止不续跑） |
| `actionCooldownSec` | `60` | 两次自动动作的最小间隔 |
| `resumeWithoutUI` | `false` | 是否允许在无 UI 模式（`-p`/`json`）下自动续跑 |
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
| `PI_GUARD_MODE` | `observe` / `guard` / `yolo` |
| `PI_GUARD_IDLE_WARN_MS`、`PI_GUARD_IDLE_CRITICAL_MS` | 静默阈值（毫秒） |
| `PI_GUARD_RUNTIME_WARN_MS`、`PI_GUARD_RUNTIME_CRITICAL_MS` | 挂钟阈值（毫秒） |
| `PI_GUARD_SOFT_KILL_GRACE_MS` | 软杀宽限期（毫秒） |
| `PI_GUARD_ACTION_COOLDOWN_MS` | 两次自动动作的最小间隔（毫秒） |
| `PI_GUARD_MAX_AUTO_RESUMES` | 每会话最多自动续跑次数（0–10） |
| `PI_GUARD_RESUME_WITHOUT_UI=1` | 允许无 UI 模式自动续跑 |
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

**自动处置会不会误伤？**
只会对**超过严重阈值**的静默生效，且只处置一次、有冷却期、最多续跑 1 次。默认 `observe` 下完全不动手——建议先观察一段时间再切 `guard`。

**同时装本地源码和 npm 包会怎样？**
pi 会直接**报错并拒绝加载**（两个扩展都注册 `--no-guard`，flag 冲突），不会静默加载两次。切换时先 `pi remove` 再 `pi install`。

## 许可

MIT

> 架构、检测模型、测试策略与发布流程等实现细节见 [`AGENTS.md`](./AGENTS.md)。
