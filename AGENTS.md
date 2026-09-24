# AGENTS.md — pi-hang-guard 维护者须知

> 面向自动化 agent 与维护者的项目上下文。**用户可见的安装使用说明见 [`README.md`](./README.md)。**

## 项目是什么

pi（pi-coding-agent）的命令执行看门狗：监听工具执行事件，用「静默时长」判定 shell 命令是否卡死，按阈值给出底栏状态与通知。以 **pi package** 形式发布到 npm。

当前版本 **0.1.x 为纯观察模式**：不覆盖内置工具、不杀进程、不中止对话、不改写命令。参见[路线图](#路线图)。

## 文档分工（约定）

| 文件 | 面向 | 内容 |
| --- | --- | --- |
| `README.md` | 使用者 | 安装、命令、配置表、环境变量、常见问题 |
| `AGENTS.md`（本文） | 维护者 / agent | 架构、检测模型、不变量、测试策略、发布流程、路线图 |

**改动用户可见行为时必须同步更新 `README.md`；改动实现细节必须同步更新本文。** 不要把实现原理写进 README。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 扩展入口：事件订阅、ticker 生命周期、`/guard` 命令、UI 安全包装 |
| `engine.ts` | 状态机：跟踪运行中工具、计算判定等级、产出状态与通知（无定时器、无时钟、无 I/O） |
| `classify.ts` | 命令分类与归一化（纯正则/字符串） |
| `config.ts` | 配置加载、字段校验、环境变量覆盖（纯函数，可注入读取器） |
| `format.ts` | 状态栏与通知文案格式化（纯字符串） |
| `tests/` | 四个套件，51 个用例，`node --test` 原生 TS 类型擦除 |
| `scripts/verify-live-rpc.mjs` | 真实 pi 进程端到端验证（不发布） |
| `.github/workflows/publish.yml` | npm Trusted Publishing 自动发布 |

无构建步骤、无测试框架依赖、**无任何运行时依赖**（peer deps 由 pi 宿主解析）。

## 架构与不变量

### 为什么 engine 是纯状态机

`createGuardEngine(deps)` 只接收注入的 `now()`、`config()`、`ui`，**自己从不创建定时器**：宿主按 `tickIntervalMs` 调用 `engine.tick()`。好处是全部判定逻辑可以用假时钟确定性单测（`tests/engine.test.ts` 就是在推进 `clock` 后手动 `tick()`），不需要 `setTimeout` 等待。

**不变量：**

1. **engine 不抛异常、不读时钟、不做 I/O。** UI 调用统一走 `tryUi()` 包装，UI 抛错不得影响内部记账（有用例保护）。
2. **只有 `index.ts` 触碰定时器和 pi API。** 新增行为优先加在 engine（可测），只有接线才写进 index。
3. **插件绝不改变工具行为。** 只读事件，不注册工具、不改 `event.input`、不碰 `operations`。

### 主机接线（`index.ts`）

订阅事件：`tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `ui_prompt_start` / `ui_prompt_end` / `agent_settled` / `session_start` / `session_shutdown`。

**ticker 生命周期：**
- 懒启动：`tool_execution_start` 且 `engine.hasRunning()` 时才 `setInterval`
- 停止：没有运行中工具时、`agent_settled`、`session_shutdown`、以及 tick 抛错时
- `unref()`：绝不因为看门狗让 pi 进程不退出
- **stale 检测**：`/reload` 后旧闭包的定时器可能仍指向失效的 UI 上下文。`ui.setStatus`/`notify` 抛错即置 `stale = true` 并停表，之后不再触碰 UI

**`activeCtx`**：pi 只在事件回调里给 `ExtensionContext`，因此每次回调都刷新 `activeCtx`，ticker 用它访问 `ui`。`session_start` 里读取 `pi.getFlag("no-guard")`（CLI flag 在工厂执行阶段还不可用）。

**配置快照**：工厂执行时 `loadConfig()` 一次，之后 `/guard on|off` 改内存副本、`/guard reload` 重读。`effectiveEnabled()` = 配置开关 AND 非 `--no-guard`。

**失败兜底原则**：`onTick()` 整体 try/catch；tick 抛错只停表，绝不让异常冒泡成 pi 的 uncaughtException。

## 检测模型

### 三种信号

| 信号 | 来源 | 适用范围 |
| --- | --- | --- |
| **静默** | `tool_execution_update` | 仅流式工具（内置只有 `bash`） |
| **挂钟运行时长** | `tool_execution_start` → now | 非流式工具，以及自带超时的命令 |
| **冻结** | `ui_prompt_start` / `ui_prompt_end` | 暂停全部计时 |

**为什么只有 `bash` 能做静默检测**：pi 内置工具里只有 `bash` 会调用 `onUpdate`——`read` / `write` / `edit` / `grep` / `find` / `ls` 的签名是 `_onUpdate`（未使用），`powershell.js` 也没有。对它们测静默会把每次调用都判成卡死。因此配置里有 `streamingTools` 白名单，默认 `["bash"]`。

bash 的输出经 `onUpdate` 上报，节流 100ms（`BASH_UPDATE_THROTTLE_MS`，`dist/core/tools/renderers/bash.js:15`）——这正是「静默」可测量的前提。

**为什么不用总超时代替静默判据**：总超时只有两种结局——要么误伤健康的长构建，要么设得足够长以至于形同虚设。而且超时不会告诉你卡在哪条命令、已经静默多久、期间有没有输出；静默判据这些都给得出，也不误伤持续输出的长任务。

### basis 选择
```
idleCapable = streamingTools.includes(toolName) && !selfTimed
basis       = idleCapable ? "idle" : "runtime"

idle 观测值    = now - max(startedAt, lastActivityAt)
runtime 观测值 = now - startedAt
```

`selfTimed`：命令自带边界（`timeout 600 …`、`--timeout 30`），其静默阶段本来就有界，因此退回挂钟，避免双重报警。

### 阈值决策

```
basis=idle 且 idleWhitelisted  →  idleWhitelistWarnSec / idleWhitelistCriticalSec
basis=idle                     →  idleWarnSec / idleCriticalSec
basis=runtime                  →  runtimeWarnSec / runtimeCriticalSec
level = 观测值 >= criticalSec*1000 ? 2 : 观测值 >= warnSec*1000 ? 1 : 0
```

`idleWhitelist` 是**抬高阈值**而不是「关掉守护」——静默的 `docker build` 仍然应该在更晚的时候被报出来。

### 状态文案去重

`Entry.lastStatusText` 缓存上一次推给 UI 的字符串，只有渲染文本变化时才 `setStatus`。若不做这层去重，500ms 的 tick 会在「显示的秒数」未变时反复重绘底栏（真实 RPC 验证时发现的：9 秒静默产生 15 次 `setStatus`，去重后为 10 次）。

### UI 冻结的位移算法

`tool_execution_start` 早于 `tool_call`（pi 生命周期图），而权限确认弹窗、选择器都发生在 `tool_call` 阶段。若不冻结，「你思考了 5 分钟要不要允许」会被判成「工具卡死 5 分钟」。

- `uiPromptStart`（深度 0→1）记 `pausedAt`
- 冻结期间 `tick()` 直接返回，且 `onToolUpdate` **不更新** `lastActivityAt`（整个记账一起冻结，保持一致）
- `uiPromptEnd`（深度→0）计算 `delta = now - pausedAt`，把每个 entry 的 `startedAt` 与 `lastActivityAt` 同时后移 `delta`

### 状态栏 key 与清理（回归保护）

key 方案 `guard:${toolCallId}`，**必须保持 per-tool**：pi 默认并行执行同一批次工具，早期版本用固定 key（`"watchdog"`）导致并发工具互相覆盖，且一个工具结束会清掉另一个的状态。

**`tool_execution_end` 与 `clearAll()` 必须无条件清理状态**，不能依赖「是否曾警告过」之类的条件标记：早期版本只在 warn 定时器触发时置位标记，若 critical 先生效（阈值配反）标记仍为 false，底栏状态会永久残留并跨会话。`tests/engine.test.ts` 中「并发工具状态隔离」与「仅 critical 触发也要清状态」两个用例就是这两条的保护。

### 通知配额

`maxNotificationsPerCall`（默认 2 = 警告 + 严重）按**每次工具调用**计数，不计入「结束汇报」。设为 1 会连严重提醒一起省掉，这是使用者的选择，不是缺陷。

## 配置解析契约

优先级由低到高：默认值 → 配置文件 → `PI_WATCHDOG_*` → `PI_GUARD_*`。

- 配置路径：`$PI_GUARD_CONFIG` → `$PI_CODING_AGENT_DIR/hang-guard.json` → `~/.pi/agent/hang-guard.json`（`PI_CODING_AGENT_DIR` 是 pi 自己的 agent 目录环境变量，见 `dist/config.js:406`）
- **`loadConfig` 永不抛异常**：文件缺失静默回退；JSON 解析失败/字段类型错误/越界/正则非法都只记 warning 并保留默认值
- 数值字段：接受数字或数字字符串，范围 `0.001 ~ 86400` 秒（`tickIntervalMs` 为 `20 ~ 600000` ms）；`idleCriticalSec < idleWarnSec` 会被钳制并告警
- `mode`：0.1.x 只接受 `"observe"`，`"guard"`/`"yolo"` 视为「未实现」，告警后回退
- `mergeConfig` 不修改入参（深拷贝）；`loadConfig` 必须把**读取阶段的 warning 与合并阶段的 warning 合并返回**（曾经漏掉前者，导致坏配置静默失败）

## 打包约束

- `package.json` 的 `files` 决定发布内容；**新增源文件必须同步加入**
- `pi.extensions: ["./index.ts"]` 是唯一入口
- **`index.ts` 只允许 `import type` 引用 pi SDK**，不允许运行时 import。理由：这样入口可在无 pi 的进程里直接加载和测试（打包测试会断言这一点）
- 入口里的 `VERSION` 常量必须与 `package.json` 的 `version` 一致——有专门用例把关，改版本时两处同改
- `peerDependencies` 声明 `@earendil-works/pi-coding-agent: "*"`，不打包 peer deps

## 测试策略

```bash
npm test                                   # 51 个用例
PI_SDK_ENTRY=/path/to/@earendil-works/pi-coding-agent/dist/index.js npm test   # 额外启用真实加载器用例
```

| 套件 | 保护什么 |
| --- | --- |
| `tests/classify.test.ts` | 分类与归一化；含反例 `echo 'npm run dev'`、`git commit -m`、`docker run -d` 不得误判为 watcher/interactive |
| `tests/config.test.ts` | 默认值、坏 JSON、类型错误、越界钳制、env 优先级、旧变量兼容、不可变性、`configPathFor` |
| `tests/engine.test.ts` | 静默触发/不触发、非流式走挂钟、self-timed、白名单抬高、并发隔离、状态无条件清理、UI 冻结位移、通知配额、状态文案去重、UI 抛错不破坏记账 |
| `tests/packaging.test.ts` | 清单有效性、入口在 `files` 内、入口的本地依赖全部在 `files` 内、`VERSION` 与 package.json 一致、入口无运行时 SDK 依赖、驱动 pi 自己的 `discoverAndLoadExtensions` 真实加载 |

**测试抓出过的真 bug（都已修，勿回退）：**

1. `loadConfig` 只返回了合并阶段的 warning，丢掉了读取阶段的 warning → 坏配置文件静默失败
2. `SELF_TIMED` 用了 `\b--timeout`，而 `\b` 在空格与 `-` 之间不成立 → `curl --timeout 10` 检测不到
3. （真实 RPC 验证发现）底栏每 500ms 重绘一次，但显示文本只按秒变化 → 同一秒重复重绘

### 真实 RPC 验证

单测用注入时钟，**无法证明 pi 真实事件顺序符合预期**。`scripts/verify-live-rpc.mjs` 补这一段：以 `pi --mode rpc` 启动真实会话（RPC 模式下 `setStatus`/`notify` 变成可观测的 `extension_ui_request` 事件），把阈值压到 2s/4s，让模型跑 `sleep 9`，断言产生了状态与通知、且工具结束时状态被清空。会消耗一次模型调用。

已验证输出（节选）：

```
[guard:call_00_ET_82...] ⏱ bash · 2s 无输出 · one-shot · sleep 9
[guard:call_00_ET_82...] ⚠ bash · 4s 无输出 · one-shot · sleep 9 · 仅提醒
[guard:call_00_ET_82...] <cleared>
(warning) bash 2s 无输出（one-shot）| 命令: sleep 9 | 可能卡住…按 Esc 中断。
(error)   bash 4s 无输出（超过 4s 阈值）| 疑似卡死。当前为观察模式，不会自动中断…
(info)    bash 最终完成（耗时 9s，最长静默 9s）
RESULT: guardFired=true statusCleared=true
```

## 本地开发与发布

### 本地接入

```bash
pi install /absolute/path/to/pi-hang-guard   # 本地路径，不复制源码
pi list                                          # 确认解析到的绝对路径
pi remove /absolute/path/to/pi-hang-guard     # 卸载
```

pi 以 jiti（module cache 关闭）加载扩展，**改完 `/reload` 即生效**，无需重启（settings 里新增的 package 需要重启或 reload）。

### 发布流程（npm Trusted Publishing / OIDC）

与 `pi-footer-styler` 保持同一套约定：**仓库与本机不保存任何长期 token**。

- 触发条件：推送到 `master` **且**最新提交的主题（首行）以 `[release]` 开头
- 发版命令：

  ```bash
  npm version patch -m "[release] %s"     # 或 minor / major
  git push origin master --follow-tags
  ```

- 一次性前置配置（npm 网页，代码无法代做）：包页 → Settings → Trusted Publisher → GitHub Actions，填 `ducaoya` / `pi-hang-guard` / `publish.yml`
- workflow 行为：升级 npm → 用 `npm view` 查重（该版本已存在则跳过）→ `npm publish --provenance --access public`

### 首次发布必须先手动一次（重要）

**npm 没有「pending publisher」机制**：Trusted Publisher 只能在包已经存在于 registry 之后才能绑定。因此**第一个版本无法由 CI 发出**——直接用 workflow 会失败。

顺序必须是：

1. 本地 `npm login` 后 `npm publish --access public` 发出 0.1.0（此时才创建了包）
2. 到 npm 包设置页绑定 Trusted Publisher（上一步的配置）
3. 此后所有版本都走 `[release]` 主题 + CI 自动发布；0.1.0 会被 workflow 的查重逻辑跳过，属正常现象

替代方案（不想本地 hold token 时）：先用 `npx setup-trusted-publishing` 之类工具发一个 `0.0.0` 占位版本，再绑定 Trusted Publisher，然后由 CI 发 0.1.0。

### 禁忌

- ❌ 不要 `npm config set //registry.npmjs.org/:_authToken=...`（凭据不入 `~/.npmrc` 常驻）
- ❌ 不要把 token 提交进仓库或粘贴进对话
- ❌ 不要给普通提交用 `[release]` 开头的主题（会触发发布）
- ❌ 不要把 `tests/`、`scripts/`、`AGENTS.md` 加进 `files`

## 路线图

**0.1.x（当前）**：非侵入观察——静默检测、命令分类、UI 冻结、`/guard`。

**0.2 分级处置**（需先确认，破坏性能力默认关闭）：

| 级 | 动作 | 机制 | 代价 |
| --- | --- | --- | --- |
| L0 | 提醒 | 现有实现 | 无 |
| L1 | 软杀已登记子进程 | pi 内部 `killTrackedDetachedChildren()` | 作用域全局（会连带 `!` 命令与并发 shell） |
| L1' | `ctx.abort()` | 官方 API | turn 级：同批工具一起死，且在途 LLM 流也停 |
| L2 | 自动续跑 | `agent_settled` + `pi.sendMessage(…, { triggerTurn: true })` | 需要护栏 |

**L1 优先于 L1' 的理由**：软杀后子进程以非零退出码返回，`bash` 工具产出的是一条普通的「命令失败」结果，**turn 不中断**，模型能当场接着处理；`ctx.abort()` 会结束整轮且不会自动继续。

**L2 必须有的护栏**：只对**我们自己发起**的中断续跑（用户按 Esc 触发的绝不续跑）；用 `setTimeout(…, 0)` 跳出 `agent_settled` 的同步调用栈（从 `_runAgentPrompt` 的 finally 里再起 run 是重入）；每轮最多续跑 `maxAutoResumes` 次；`hasUI === false`（print/json 模式）时默认不续跑。

**0.3 致命模式检测**：仅 watcher 类、仅在启动窗口（约 3s）内匹配不可自愈的错误（`Pre-transform error`、`MODULE_NOT_FOUND`、`EADDRINUSE`…）。**明确排除** `error TS\d+`、`ERROR in`、`warning`——它们在 watch 循环里是常态且可自愈，纳入即误杀。

## pi 实现约束速查表

以下事实在 **pi 0.86.0** 上核实，改动前请重新验证。它们是本插件形态的成因，不是偏好。

| 事实 | 影响 | 出处 |
| --- | --- | --- |
| `bash` 工具无默认超时，只按退出码判失败 | 「进程活着但报错」永远等不到失败 → 本插件存在的理由 | `dist/core/tools/bash.js:28,256-266` |
| 内置工具中只有 `bash` 会发 `tool_execution_update` | 静默检测必须限定 `streamingTools` | `dist/core/tools/{read,write,edit,grep,find,ls}.js` 的 `_onUpdate` |
| `tool_execution_update` 节流 100ms | 静默可测；事件处理器必须极轻 | `dist/core/tools/renderers/bash.js:15` |
| 事件顺序 `start → tool_call → 执行 → update* → tool_result → end` | 权限弹窗等待落在 start 之后、`tool_result` 慢操作落在 end 之前 → 需要 UI 冻结 + 优先用 update 流 | `docs/extensions.md:303-311` |
| `ui_prompt_start` / `ui_prompt_end` 可用 | 冻结机制的入口 | `dist/core/extensions/types.d.ts:567-577` |
| `killProcessTree`：win32 走 `taskkill /F /T`，POSIX 走 `process.kill(-pid, SIGKILL)` | 软杀与中断都能杀整棵进程树（POSIX 下 bash 是独立进程组） | `dist/utils/shell.js:184` |
| `trackedDetachedChildPids` 模块级注册表 + `killTrackedDetachedChildren()` | 0.2 软杀路径；但**不在 exports 映射里**，需 `getPackageDir()` 拼绝对路径动态 import，且作用域全局 | `dist/utils/shell.js:165-181` |
| `ctx.abort()` 存在 | 无需覆盖 bash 工具即可中断 | `dist/core/extensions/types.d.ts:238-239` |
| `ctx.abort()` → run signal → `tool.execute` 的 signal → 工具杀进程 | 中断链路成立 | `agent-session.js:1341,2171` → `pi-agent-core/dist/agent.js:211` → `agent-loop.js:507` |
| abort 后 `_agentRunAbortRequested` 阻止自动继续 | 需要 L2 主动开新一轮 | `dist/core/agent-session.js:872,883-886` |
| `agent_settled` 在 `_runAgentPrompt` 的 finally 中同步 emit | 从其中起新 run 是重入，必须 `setTimeout(…, 0)` | `dist/core/agent-session.js:367-377,877` |
| package `exports` 只暴露 `.` / `./rpc-entry` / `./client` / `./experimental/plugin` | 深路径 import 会被拦；`getPackageDir()` 是唯一出口 | `package.json#exports` |

## 决策记录

| 日期 | 决策 | 理由 |
| --- | --- | --- |
| 2026-09-24 | 判据用「无输出时长」而非「运行时长」 | 只看运行时长必然误报长构建 |
| 2026-09-24 | 静默检测只对 `streamingTools`（默认 `bash`）生效 | 序列化/简单工具不发 update 事件 |
| 2026-09-24 | UI 提示期间冻结计时 | `tool_execution_start` 早于权限弹窗 |
| 2026-09-24 | 状态栏 key 用 `guard:${toolCallId}`，结束时无条件清理 | 修复并发覆盖与状态残留两个真实缺陷 |
| 2026-09-24 | 0.1.x 不含任何处置动作 | 先观察、先降误报，破坏性能力单独评估 |
| 2026-09-24 | 入口只允许 `import type` 引用 SDK | 保证可在无 pi 进程内加载与测试 |
| 2026-09-24 | 文档分工：README 面向使用者，AGENTS.md 面向维护者 | 与 `pi-footer-styler` 保持同一套约定 |
