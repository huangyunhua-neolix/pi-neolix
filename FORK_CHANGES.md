# Fork Change Log - pi-neolix

> 本文件记录 **pi-neolix** fork 相对 upstream(pi 官方仓库)的**自定义源码改动**。
>
> 每次 `git pull` / `rebase` / `merge` upstream 后,按本文件核对改动是否保留;
> 新增 fork feature 时,在「改动清单」追加一节,格式见模板。
>
> - **Fork 仓库**: `huangyunhua-neolix/pi-neolix`
> - **Upstream**: pi 官方仓库(分支 `main`)
> - **当前 fork 基线**: `f7d3331d` (fix(ai): mock copilot models in oauth test, 2026-06-22 upstream/main)
>   - 上次同步: 2026-06-23,rebase 86 个 upstream 提交(Models API 重构 phase 1-8、overflow compaction 修复、安全更新等)。
>   - 同步前基线: `7a14325b` (2026-06-18)。

---

## 与 upstream 同步的工作流

1. `git fetch <upstream> main`
2. `git rebase <upstream>/main`(或 merge)
3. 若下列文件出现冲突 / 被上游改动覆盖,按对应章节的「冲突处理」恢复:
   - `packages/coding-agent/src/core/web-bridge.ts` - **新增文件**,upstream 不会有同名冲突,除非上游也加了 `web-bridge.ts`。
   - `packages/coding-agent/src/modes/interactive/interactive-mode.ts` - 4 处接线点,见下文「接入位置」。
   - `packages/coding-agent/test/web-bridge.test.ts` - 新增测试文件。
   - `packages/coding-agent/src/core/resource-loader.ts` - FEAT-002 两处改动(候选顺序 + 用户级 `~/.claude/CLAUDE.md`)+ FEAT-003 `reload()` 注入 plugin 发现,见下文。
   - `packages/coding-agent/src/core/claude-plugins.ts` - **新增文件**(FEAT-003),upstream 不会有同名冲突。
4. 同步后跑 `npm run check`(coding-agent)和 `web-bridge` 的单测,确认改动仍生效。
5. 如果 fork feature 已被 upstream 以等价方式实现,删除本文件对应章节并改为引用 upstream 实现。
6. **2026-06-23 同步备注**(本次 rebase 实际冲突 / 取代情况):
   - `resource-loader.ts` `reload()` 开头:upstream 新增 `if (this.loaded) clearExtensionCache();`,fork 的 FEAT-003 plugin 发现块也在同位置。解法:**两者并存**(先清缓存、再发现插件路径),已合并。
   - `packages/agent/src/harness/compaction/branch-summarization.ts`:upstream Models 重构把 `generateBranchSummary` 的解构从 `apiKey, headers` 改为 `models`(phase 6)。fork 的 `contextWindow || 200000` 改动紧邻。解法:**取 upstream 的 `models` 解构 + 保留 fork 的 200k 回退值**。
   - **已被 upstream 取代的游离提交**(未在本文件单独记录,本次 rebase 后 redundant-but-harmless,保留):
     - `94cecf3b` strip overflow assistant regardless of stopReason —— upstream `6b9f3f49`(closes #5720)`willRetry = stopReason !== "stop"` 以更优方式修复同一 "Cannot continue from assistant" bug。fork 的 strip-any 块现冗余但无害,21/21 compaction 测试仍绿。下次清理可删除该提交。
     - `26f91520` preserve overflow-recovery guard —— upstream 未触及该区域,仍独立有效,保留。
   - 本次同步发现的 2 个 upstream 既存问题已记入下文「已知问题(upstream-inherited)」章节跟踪。

> 数据文件不算自定义改动:`packages/ai/src/models.generated.ts`、
> `packages/ai/src/image-models.generated.ts` 跟随 upstream 重新生成即可
> (见 `AGENTS.md`:改 `generate-models.ts` 后 regenerate),同步时直接采纳上游版本。
> `packages/ai/package.json` 多出的 `@smithy/types` 依赖若是 fork 引入需保留,
> 否则按上游。

---

## 改动清单

## 已知问题(upstream-inherited,待跟踪)

> 以下问题均**非 fork 引入**,而是 upstream `f7d3331d` 自身在 `openai@6.26.0` + 当前依赖环境下的既存缺陷,rebase 后被动继承。fork 侧暂不修(避免与 upstream 分叉),跟踪 upstream 修复后随同步纳入。

### 已知-1 · pi-ai build 失败:`mistral-conversations.ts` `promptCacheKey` 类型错误

- **现象**: `npm run build`(packages/ai)报 `src/api/mistral-conversations.ts(258,47): error TS2339: Property 'promptCacheKey' does not exist on type 'ChatCompletionStreamRequest'.`,pi-ai dist 无法重新生成。
- **根因**: upstream `651d10d9`(feat(ai): enable Mistral prompt caching)在 `mistral-conversations.ts:258` 写 `payload.promptCacheKey = options.sessionId;`,`payload` 类型为 `ChatCompletionStreamRequest`。但 `openai@6.26.0`(upstream `packages/ai/package.json` 钉此版本,无 `overrides`)的该类型无 `promptCacheKey` 字段。`skipLibCheck` 管不到(是源码赋值,非 `.d.ts`)。
- **证据**: fork main(rebase 前)pi-ai build 成功(无此代码);rebase 后被动继承;`git diff upstream/main HEAD -- packages/ai/src/api/mistral-conversations.ts` 为空(fork 未改此文件)。
- **影响**: pi-ai dist 不能重建 → 目前用 fork main 旧 dist 凑合运行,新模型/Provider 改动无法生效。
- **处置**: fork 侧不动。跟踪 upstream 修复(可能需升 `openai` 到含该字段的版本,或 upstream 改用类型断言/扩展)。upstream 修复后随下次 rebase 自动纳入。

### 已知-2 · `resource-loader.test.ts` 5 个扩展加载测试失败

- **现象**: `npx vitest run test/resource-loader.test.ts` 报 `5 failed | 17 passed (22)`。失败用例均为 upstream 既有测试:
  - `should load symlinked user and project extensions once`
  - `should load user extensions before trust and reuse them after trust resolves`
  - `should keep both extensions loaded when command names collide`
  - `should detect tool conflicts between extensions`
  - `should prefer explicit CLI extensions over discovered extensions when commands and tools conflict`
- **根因**: upstream `5505316e`(fix(coding-agent): cache extension imports for session switches)引入 `loadExtensionsCached` + 模块级缓存 + `clearExtensionCache()`(仅 `if (this.loaded)` 时清)。vitest 单进程跨用例共享该模块级缓存,首个用例的 `this.loaded=false` 不清缓存,导致后续用例读到陈旧缓存 → 扩展加载结果为空 / 冲突检测失效。
- **证据**: **upstream/main 纯净版**(独立 worktree,同一 node_modules)同样 `5 failed | 17 passed`,失败用例完全相同。fork main(rebase 前)因仍用未缓存的 `loadExtensions` 而 22/22 全过。
- **影响**: 仅测试隔离问题,不影响 fork 自身功能;但 `npm run check` / CI 会红。
- **处置**: fork 侧不动。若 upstream 未修且需让 CI 绿,可在 vitest 配置层给该文件加 `pool: 'forks'` 或按用例 `clearExtensionCache()`(属 upstream 测试基础设施,不在 fork 改动范围)。

### FEAT-001 - Web Adapter 信号桥(OSC 9998 / 9999)

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: 让 pi 在 freecode-web 适配器下,会话状态 / 计费 / context 跟 freecode 一样准确(否则 web UI 全显示 "-")。

#### 背景 / 契约

freecode CLI 通过两条 OSC 转义序列把状态传给 web server 的 PTY 解析器
(`freecode-web-submodule/web/server/pty-parser.mjs`):

| 序列 | 格式 | 携带 |
|---|---|---|
| OSC 9998 | `ESC]9998;status=<idle\|running\|error>;bg=<N>;agents=<N>BEL` | 会话状态、LED、autoupdate subagent gate |
| OSC 9999 | `ESC]9999;used=<tokens>;limit=<tokens>;cost=<usd>BEL` | context 用量、窗口上限、累计费用 |

pi 原本不发射这些序列,web server 把 pi 当 passthrough backend,状态/计费/context 全部丢失。
本 feature 让 pi 镜像 freecode 的发射逻辑,订阅 `AgentSession` 事件并翻译成 OSC。

#### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/core/web-bridge.ts` | **新增** | OSC 发射 + `WebBridge` 事件订阅器 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 修改 | 4 处接线点(见下) |
| `packages/coding-agent/test/web-bridge.test.ts` | **新增** | 单元测试(env 门控、事件→OSC 翻译) |

> 配套的 web server 侧改动(`pty-parser.mjs` 让 pi backend 解析 OSC;
> `child-env.mjs` 注入 `FREECODE_WEB=1`)在 `freecode-web-submodule` 仓库,
> 不在 pi 内,同步 pi upstream 时无需关注。但**两者必须配套上线**:
> 仅升级 pi 不重装 web server,`FREECODE_WEB` 未注入则 pi 不发射。

#### 接入位置(`interactive-mode.ts`)

1. **import**(顶部 import 区):
   ```ts
   import { WebBridge } from "../../core/web-bridge.ts";
   ```
2. **字段声明**(紧邻 `private unsubscribe?: () => void;`):
   ```ts
   // Emits OSC 9998/9999 status/cost/context frames to the freecode-web PTY
   // adapter. No-op unless FREECODE_WEB=1 (bare terminal stays silent).
   private webBridge = new WebBridge();
   ```
3. **`subscribeToAgent()` 末尾**(每次 rebind/reload 都会调,所以会话切换时重新挂):
   ```ts
   // Re-emit status / cost / context as OSC frames for the web adapter.
   // attach() detaches any prior subscription first, so rebind is safe.
   this.webBridge.attach(this.session);
   ```
4. **`stop()` 里**(紧跟 `this.unsubscribe()` 之后):
   ```ts
   // Drop the web-bridge subscription so it can't fire after teardown.
   this.webBridge.detach();
   ```

#### 事件 → OSC 映射(`web-bridge.ts` `handleEvent`)

- `agent_start` → `9998 status=running;bg=1;agents=1`
- `message_end`(assistant)/ `compaction_end` → `9999 used+limit+cost`
  (cost 走 `sessionManager.getEntries()` 全量累加,跨 compaction 不丢,
  与 `components/footer.ts` 一致)
- `agent_end`:
  - `willRetry=true` → 保持 `running`(避免闪一帧 idle)
  - 否则 → `idle`,若末条 assistant `stopReason==="error"` 则 `error`

#### 门控

发射仅在 `process.env.FREECODE_WEB === "1"` 时启用(`isWebAdapter()`)。
web server 的 `BuildChildEnv_` 给所有 spawn 的 CLI 子进程注入该变量。
**裸终端运行 pi 时完全静默**--OSC 对普通终端是不可见的(未知 OSC 被吞),
且是非光标移动序列,不干扰 pi 自身的 TUI 全屏渲染。

#### 冲突处理

- **`web-bridge.ts` 不存在 / 被删** → 从本 fork 的 git 历史恢复(`git checkout
  HEAD -- packages/coding-agent/src/core/web-bridge.ts`),或按本文重建。
- **`interactive-mode.ts` 接入点消失**(rebase 后 `subscribeToAgent` / `stop` 被重写)
  → 重新应用上面 4 处接入。关键是:创建 session 订阅后 `attach`,
  teardown 时 `detach`。
- **`AgentSession` 事件类型变化**(如 `agent_end.willRetry` 改名)
  → 更新 `handleEvent` 的类型守卫;`AgentSessionEvent` 定义在
  `packages/coding-agent/src/core/agent-session.ts`。
- **`sessionManager.getEntries()` / `getContextUsage()` API 变化**
  → 对照 `components/footer.ts`(消费同样 API 渲染 cost/context)同步修改。

#### 测试

```bash
cd packages/coding-agent
./node_modules/.bin/vitest --run test/web-bridge.test.ts
```

#### 验证(端到端,需配套 web server)

启动一个 pi 会话后,web 侧 LED 应从 idle→running,context 条 / cost 会随 turn 更新,
而非一直显示 "-"。autoupdate 的 subagent gate 也会因 `agents=1` 在 turn 中阻塞安装。

---

### FEAT-002 - CLAUDE.md 优先加载 + 用户级 `~/.claude/CLAUDE.md`

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: 让 pi 的 context file 发现逻辑对齐
freecode CLI 的 memory 加载模型--(1) 同一目录同时存在 `AGENTS.md` 和 `CLAUDE.md` 时,
**优先 CLAUDE.md**;(2) 除全局 `~/.pi/agent/` 外,**额外加载用户级 `~/.claude/CLAUDE.md`**,
让 pi 与 freecode CLI 共享同一份用户指令。

#### 背景:freecode CLI 加载模型(参考)

freecode(`src/utils/claudemd.ts`)按以下层级加载,**后加载优先级更高**(离 cwd 越近越优先):

| 层 | 路径 |
|---|---|
| Managed | `<managed>/.claude/CLAUDE.md` |
| **User** | **`~/.claude/CLAUDE.md`**(`getClaudeConfigHomeDir`) |
| Project(每层) | `CLAUDE.md` + `.claude/CLAUDE.md` + `.claude/rules/*.md` |
| Local | `<dir>/CLAUDE.local.md` |

#### 改动文件
| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/core/resource-loader.ts` | 修改 | (1) `loadContextFileFromDir` 的候选顺序从 `[AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD]` 改为 `[CLAUDE.md, CLAUDE.MD, AGENTS.md, AGENTS.MD]`;(2) `loadProjectContextFiles` 在全局段额外读 `~/.claude/CLAUDE.md`(仅 CLAUDE.md 候选,不含 AGENTS.md)。 |

#### 接入位置(代码)

1. **候选顺序**(`loadContextFileFromDir`):
   ```ts
   // FEAT-002 (freecode-web adapter): CLAUDE.md is preferred over AGENTS.md
   const candidates = ["CLAUDE.md", "CLAUDE.MD", "AGENTS.md", "AGENTS.MD"];
   ```
2. **用户级补读**(`loadProjectContextFiles`,agentDir 段之后):
   ```ts
   // FEAT-002: also load the freecode user-level memory file ~/.claude/CLAUDE.md
   const claudeUserDir = resolvePath(join(homedir(), ".claude"));
   if (claudeUserDir !== resolvedAgentDir) {
       const claudeUserContext = loadContextFileFromDir(claudeUserDir);
       if (claudeUserContext && !seenPaths.has(claudeUserContext.path)) {
           contextFiles.push(claudeUserContext);
           seenPaths.add(claudeUserContext.path);
       }
   }
   ```

#### 范围说明(相对 freecode 的取舍)

本 feat **不**实现 freecode 的以下能力(方案 A 边界):
- `.claude/CLAUDE.md`(项目内嵌套)
- `.claude/rules/*.md`
- `CLAUDE.local.md`(私有项目指令)
- Managed memory
如需对齐,后续另开 FEAT。

#### 冲突处理

- **`loadContextFileFromDir` 的候选数组被上游重写** → 重新把 `CLAUDE.md` 调到 `AGENTS.md` 之前(双大小写变体都保持 CLAUDE 在前)。
- **`loadProjectContextFiles` 全局段被重写** → 在 agentDir 读取之后、项目 walk 之前,补回 `~/.claude/CLAUDE.md` 的加载块。
- **`homedir` / `resolvePath` import 变化** → `homedir` from `node:os`,`resolvePath` from `../utils/paths.ts`,两者保持。
- **`agentDir` 本身已是 `~/.claude`**(理论可能,实际不会)→ `if (claudeUserDir !== resolvedAgentDir)` 去重,不会重复读。

#### 测试

```bash
cd packages/coding-agent
./node_modules/.bin/vitest --run test/resource-loader.test.ts   # 22/22
../../node_modules/.bin/tsgo -p tsconfig.build.json              # 0 error
```

#### 验证(行为)

对一个同时有 `AGENTS.md` 和 `CLAUDE.md` 的项目,pi 应优先加载 `CLAUDE.md`;
存在 `~/.claude/CLAUDE.md` 时会被一并加载(顺序在项目文件之前,即优先级更低)。
可用以下临时脚本确认(验证后删除):
```ts
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";
loadProjectContextFiles({ cwd: "<project>", agentDir: "~/.pi/agent" });
```

---

### FEAT-003 — 加载 Claude Code / freecode plugin 的 skills + slash commands

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: 让 pi 像 freecode CLI 一样能使用通过
freecode 装好的 Claude Code plugin(如 `superpowers`、`ralph-loop`)以及用户级 skill/command
(如 compound-engineering 的 `ce-*` 系列)。这些资源的本质是 `skills/`(SKILL.md)和
`commands/`(frontmatter .md)——pi 已有完全兼容的解析器,只是默认搜索目录不同。本 feat
让 pi 复用 freecode 的两套来源,无需重新实现 marketplace / 安装器。

#### 背景:freecode 资源布局

两类来源:
1. **Plugin**:`~~/.claude/plugins/installed_plugins.json`(freecode 的权威启用记录)
   列出每个已装 plugin 的 `installPath`,指向
   `~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/`。每个 plugin 可能含
   `skills/`(superpowers:14 个 SKILL.md)、`commands/`(ralph-loop:3 个 frontmatter .md)、
   hooks/MCP(本 feat 不处理)。
2. **User level**:freecode 的用户资源根 `~/.claude/skills/` 和 `~/.claude/commands/`。
   compound-engineering 的几十个 `ce-*` skill 就装在这里(不是 plugin)。

#### 改动文件
| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/core/claude-plugins.ts` | 新增 | 读 `installed_plugins.json` 发现各启用 plugin 的 `skills/`/`commands/`,**并**额外暴露 freecode 用户级根 `~/.claude/skills` 与 `~/.claude/commands`(compound-engineering `ce-*` 所在)。防御式:坏 JSON / 缺失 / 非目录一律跳过,不报错。`PI_DISABLE_CLAUDE_PLUGINS=1` 可关停。 |
| `packages/coding-agent/src/core/resource-loader.ts` | 修改 | `reload()` 开头调用 `discoverClaudePluginPaths()`,把 skills 路径追加到 `additionalSkillPaths`、commands 路径追加到 `additionalPromptTemplatePaths`。受 `noSkills`/`noPromptTemplates` 门控,保留原 opt-out 语义。 |
| `packages/coding-agent/test/claude-plugins.test.ts` | 新增 | 7 个单测:disabled / manifest 缺失 / 坏 JSON / 正常多 plugin / 取最新版本条目 / user-level 目录发现 / plugin+user 合并。 |
| `packages/coding-agent/test/resource-loader.test.ts` | 修改 | `beforeEach`/`afterEach` 用 `PI_DISABLE_CLAUDE_PLUGINS` 隔离测试,避免宿主 `~/.claude/` 污染 diagnostics。 |

#### 范围(方案 1 边界)

- **仅发现**(只读 `installed_plugins.json`),**不安装/不更新** plugin -- 安装仍走 freecode CLI(`/plugin ...`)。
- 仅消费 `skills/`(SKILL.md)和 `commands/`(frontmatter .md);plugin 的 hooks、MCP servers、setting 注入等**不处理**。
- 同名 skill 冲突由 pi 既有 collision 诊断处理(user/project 优先级高于 plugin path)。

#### 冲突处理

- **`reload()` 被上游重写** → 在 `reload` 开头重新插入 `discoverClaudePluginPaths()` 调用,
  结果分别追加进 `additionalSkillPaths` / `additionalPromptTemplatePaths`,
  并受 `noSkills`/`noPromptTemplates` 门控。
- **`installed_plugins.json` schema 变化**(version / 字段名) → `claude-plugins.ts`
  只读 `plugins.<key>[].installPath`,容错性强;若字段重名,更新 `InstalledPluginsFile`。
- **`claude-plugins.ts` 被删** → 从本 fork 历史恢复,或按本节重建。
- **plugin 提供非 skill/command 能力**(hooks/MCP) → 本 feat 明确不处理,见范围。

#### 测试

```bash
cd packages/coding-agent
./node_modules/.bin/vitest --run test/claude-plugins.test.ts    # 5/5
./node_modules/.bin/vitest --run test/resource-loader.test.ts  # 22/22(含 noSkills 门控)
../../node_modules/.bin/tsgo -p tsconfig.build.json            # 0 error
```

#### 验证(行为)

装了 `superpowers` 后,pi 启动应多出 14 个 skill(brainstorming / test-driven-development 等);
装了 `ralph-loop` 后多出 3 个 slash command(`/ralph-loop` 等)。`~/.claude/skills/` 里的
compound-engineering `ce-*`(本机 38 个,如 ce-compound / ce-brainstorm / ce-code-review)
也会被 pi 加载。可用临时脚本确认(验证后删除):
```ts
import { discoverClaudePluginPaths } from "../src/core/claude-plugins.ts";
const r = discoverClaudePluginPaths();  // skillPaths / promptPaths / loadedPlugins
```

---

### FEAT-004 — 屏蔽上游更新检查与 self-update

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: 本 fork(pi-neolix)不通过
pi.dev / upstream npm 发版,而是**定期从 fork 同步、经 freecode-web-submodule 的
autoupdate 渠道分发**。upstream 的版本号对本 fork 无意义,因此:① 启动时的版本检查
(去 `pi.dev/api/latest-version`)只会误导;② `pi update` 会重装 upstream 包覆盖 fork。
本 feat 同时屏蔽这两条路径。

#### 设计

在 `config.ts` 加编译期常量 `IS_FORK_BUILD = true`,三处生效:

1. `utils/version-check.ts` 的 `getLatestPiRelease()` — fork 构建时直接 `return undefined`,
   从源头不联网(启动检查 + `pi update` 检查都走这个函数)。`PI_SKIP_VERSION_CHECK` /
   `PI_OFFLINE` 原有开关保留作为运行时退路。
2. `package-manager-cli.ts` 的 `update > updateTargetIncludesSelf` 分支 — fork 构建时
   打印说明并 `return true`,**拒绝 self-update**,避免误装 upstream 包。
3. (未改动)interactive-mode 启动检查:调用 `checkForNewPiVersion` → 走 (1) 返回
   undefined → 不弹通知,自然失效。

`IS_FORK_BUILD` 是编译期 `true`,minify 后 fetch 调用会被 tree-shake 掉——fork 构建体
里不会残留到 pi.dev 的网络调用。

#### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/config.ts` | 修改 | 新增 `export const IS_FORK_BUILD = true` + 注释说明 fork 发版策略。 |
| `packages/coding-agent/src/utils/version-check.ts` | 修改 | `getLatestPiRelease` 开头 `if (IS_FORK_BUILD) return undefined`。 |
| `packages/coding-agent/src/package-manager-cli.ts` | 修改 | `update` 命令的 self 分支开头拦 fork 构建,提示走 freecode-web 升级。 |
| `packages/coding-agent/test/version-check.test.ts` | 修改 | `vi.mock` 把已有 fetch 测试的 `IS_FORK_BUILD` 设为 false(跑 upstream 路径);新增 `fork build` describe 验证 `IS_FORK_BUILD=true` 时不联网。 |

#### 验证(行为)

- `getLatestPiRelease()` 在 fork 构建里返回 `undefined`,**不调用 `fetch`**(实测通过)。
- `pi update`(或交互式 self-update)被拦,提示 "updates are managed by freecode-web"。
- 升级路径:`freecode-web-submodule` 的 `package-all.sh` / autoupdate 重装。

---

### FEAT-005 — `/skill:<name>` 在补全菜单中选中后留在编辑器(不立即执行)

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: 在补全菜单里输入命令前缀(如 `brain`)后按回车，
用户意图是**选中该命令名**（像 shell 补全一样）然后继续在同一行输入剩余参数；
但 pi 默认对所有 `/` 开头命令“选中即提交执行”。`/skill:xxx` 需要后续任务参数，
被立即执行会导致 skill 被展开调用，而不是等用户补全输入。内置即时命令
（`/compact` `/model` 等）“选中即执行”是合理的，应保持。

#### 设计

不改 skill 文件。在 TUI 编辑器的补全确认分支按命令类型区分行为：

| 命令类型 | 选中(回车)行为 |
|---|---|
| `/skill:xxx` | 选中→**留在编辑器**，光标停住，用户继续输入参数 |
| 内置即时命令 `/compact` 等 | 选中→**穿透提交**（保持原状） |
| 非 `/` 文件补全 | 选中→留在编辑器（保持原状） |

判定方式（运行时、不改 skill 文件）：在 `applyCompletion` 返回后，取光标所在行的命令文本，
若以 `/skill:` 开头 → 不穿透提交、留在编辑器；否则保持原逻辑。

#### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/tui/src/components/editor.ts` | 修改 | 补全确认分支新增 `/skill:` 判定：选中后不提交，留在编辑器（`applyCompletion` 已补尾部空格，光标已就位）。 |
| `packages/tui/test/editor.test.ts` | 修改 | 新增 2 个测试：`/skill:` 选中不提交 / `/compact` 选中仍提交（回归保护）。 |

#### 验证

- `editor.test.ts`: **182/182 通过**（含 2 个新测试）。tui 包全量 **687/687** 通过。
- `tsgo -p tsconfig.build.json`: **0 错误**。

---

### FEAT-006 — 新增 `/clear` 命令(作为 `/new` 的别名)

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: pi 原本只有 `/new` 命令（开新 session），
没有习惯的 `/clear`。从 Claude Code 迁来的用户输入 `/clear` 会报“未知命令”。
经评估，pi 的 `/new` 本质就是 “clear and start fresh”（且旧会话保留为独立 session、
可 `/resume` 回来，比 Claude Code 直接丢弃更安全），因此直接把 `/clear` 作为
`/new` 的别名，复用成熟的 `handleClearCommand()` 逻辑，零风险。

#### 设计选择：别名 vs 清空当前 session 上下文

曾考虑方案 B（不新建 session 文件，清空当前 session 的 messages、保持 session 身份不变，
精确匹配 Claude Code 语义）。但该方案要改动 SessionManager 持久化与 fork 树结构，
有数据丢失风险，与“绝不丢会话”铁律冲突，故不采用。别名方案（A）已完全满足需求。

#### 行为

| 命令 | 行为 |
|---|---|
| `/clear` | 与 `/new` 完全一致：开新 session，旧会话保留可 `/resume` |

#### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/core/slash-commands.ts` | 修改 | `BUILTIN_SLASH_COMMANDS` 新增 `clear` 元数据（补全菜单/帮助出现 `/clear`）。 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 修改 | 提交分发新增 `text === "/clear"` 分支，与 `/new` 走同一 `handleClearCommand()`。 |
| `packages/coding-agent/test/slash-commands.test.ts` | 新增 | 断言 `clear` 在内置命令列表且描述匹配。 |

#### 验证

- `slash-commands.test.ts`: **2/2 通过**。`tsgo -p tsconfig.build.json`: **0 错误**。

---

---

### FEAT-007 - Ctrl+C 中断运行中的会话(对齐 Claude Code)

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: upstream 下 `Ctrl+C`(`app.clear`) 仅清空编辑器,会话运行中按 `Ctrl+C` 会被当成“清空输入”而非中断,与 Claude Code 的肌肉记忆不符。让会话运行中(streaming / bash 工具运行)按 `Ctrl+C` 与 `Esc` 走同一套中断逻辑,空闲时保留原清空/双击退出行为。

#### 改动文件
| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 修改 | 抽取 `interruptActiveSession()`,`onEscape` 与 `handleCtrlC` 共用;`handleCtrlC` 开头优先中断运行中的会话。 |
| `packages/coding-agent/docs/keybindings.md` | 修改 | 更新 `app.interrupt` / `app.clear` 描述,说明 `Ctrl+C` 运行中中断、空闲清空、双击退出。 |

#### 冲突处理
`handleCtrlC` 与 `onEscape` 位于 `setupKeyHandlers()`,是 upstream 高频改动区域。rebase upstream 后:确认两个 handler 仍存在,若 upstream 重构了中断逻辑,把新的中断调用填入 `interruptActiveSession()` 内部,保持 Ctrl+C/Esc 共用一个中断入口即可。

#### 验证
`tsgo -p packages/coding-agent/tsconfig.json`: **0 错误**。

---

### FEAT-007 — skill 去重静默化 + 忽略 Claude Code 插件 cache 目录

**状态**: 已实现 · **日期**: 2026-06-20 · **动机**: FEAT-003 上线后发现两处问题:1) Claude Code
把插件(如 superpowers)装到 `~/.claude/plugins/cache/<publisher>/<plugin>/<version>/`,而同一批
skill 也在用户级 `~/.claude/skills/` 里 → 14 个同名 skill 全报 `collision` 诊断，用户每次新建会话
被刷屏。2) 即便不重名，`loadAllSkills` 的 collision 诊断对“同 skill 多路径”这种良性重复过于呏嗦。

#### 设计

两件事:

1. **忽略 cache 目录**：`discoverClaudePluginPaths()` 跳过 installPath 含 `/plugins/cache/` 的插件。
   cache 里 14 个 superpowers skill 在用户级全部存在（零损失），只信任用户级副本。

2. **skill 去重静默化**：`loadSkills` 的 `addSkills` 遇同名时不再 push `collision` 诊断，
   直接静默跳过（先加载者胜）。良性重复不再刷屏；真正的同名冲突（同名不同行为）极少，
   应由 skill 运行时自己暴露。

#### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/src/core/claude-plugins.ts` | 修改 | installPath 在 `/plugins/cache/` 下的插件跳过，不进入 skillPaths。 |
| `packages/coding-agent/src/core/skills.ts` | 修改 | `addSkills` 同名重复从 push `collision` 诊断改为静默跳过。 |
| `packages/coding-agent/test/claude-plugins.test.ts` | 修改 | 新增 cache 目录被忽略的测试。 |
| `packages/coding-agent/test/skills.test.ts` | 修改 | 新增同名 skill 静默去重（无 collision 诊断）的测试。 |

#### 验证

- `claude-plugins.test.ts` 8/8、`skills.test.ts` 29/29 通过。`tsgo -p tsconfig.build.json`: **0 错误**。
- 配套清理（运维侧）：本机删除了 `~/.pi/agent/sessions/` 下 137 个 cwd 为 `/var/folders/...` 的
  临时会话目录（测试残留）。web server 的 `PiScan_` 防御性过滤在 freecode-web-submodule 另提。

---

### FEAT-008 - subagent 派发优先使用 glm-5.2

**状态**: 已实现 · **日期**: 2026-06-22 · **动机**: subagent（`subagent` extension）派发的子进程默认用 agent 文件 frontmatter 里的 `model`（scout=haiku、planner/reviewer/worker=sonnet）。本机主力模型是 neolix provider 下的 `glm-5.2`（contextWindow 1000000、便宜），希望 subagent 统一走 glm-5.2，省 token、省成本、并统一模型行为。glm-5.2 不可用时回退 agent 指定的 model，不硬性依赖。

#### 设计（方案 A：强制覆盖）

在 `runSingleAgent` 决定子进程 `--model` 时，先经 `resolvePreferredModel(modelRegistry, defaultProvider)` 判断 glm-5.2 是否「可用」（在 **defaultProvider** 下存在且认证已配置）。`defaultProvider` 从 `~/.pi/agent/settings.json` 读，与注入子进程的 `--provider` 同源。

- 可用 → 一律 `--model glm-5.2`，**忽略** agent 文件 frontmatter 的 `model`。
- 不可用 → 回退 `agent.model`（原行为）。
- `agent.model === "inherit"` → 展开为父会话模型的 `provider/modelId`（子进程不认识裸 token `inherit`，见下「inherit 解析」）。

**provider 作用域（review 修复）**：「可用」只认 defaultProvider 那一个 provider，而非任一 provider。因为子进程被 `--provider` 钉死在 defaultProvider，若 glm-5.2 在别的 provider 下可证但 defaultProvider 下不可证，子进程会 `buildFallbackModel` 造出一个 defaultProvider 无法服务的假模型 → 静默派发失败。作用域到 defaultProvider 后，此场景安全回退到 agent.model。

「可用性」判断在父进程 extension 层完成：`execute` 的 `ctx` 是 `ExtensionContext`，直接暴露 `ctx.modelRegistry`（`ExtensionCommandContext extends ExtensionContext`，所以 `/agent:<name>` slash command 的 handler 也能拿到）。子进程收到 `--model glm-5.2 --provider neolix`（provider 由本 FEAT 一并注入的 provider patch 提供），`resolveCliModel` 在 neolix 下精确匹配，不会因跨 provider 同名（opencode-go 等也有 id=`glm-5.2`）而 ambiguous。

**inherit 解析（review 修复，pre-existing bug）**：agent 文件 `model: inherit` 表示「用父会话模型」。但子进程不认识裸 `inherit`，旧逻辑直接 `--model inherit` 传下去 → `resolveCliModel` 找不到名为 `inherit` 的模型 → neolix API 报 `Invalid model name passed in model=inherit`，派发失败（ce-* 系列 agent 全是 `model: inherit`，曾导致本 PR 的 persona 派发全部失败）。现 `runSingleAgent` 加 `sessionModel` 参数，当 `agent.model === "inherit"` 且 `sessionModel` 存在时展开为 `provider/modelId` 传给子进程。4 个调用点（single/parallel/chain + slash-command）均传 `ctx.model`。

#### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/coding-agent/examples/extensions/subagent/index.ts` | 修改 | (1) 新增并 **export** `PREFERRED_MODEL_ID="glm-5.2"` + `resolvePreferredModel(modelRegistry, defaultProvider)`（参数含 defaultProvider，作用域可用性）；(2) `runSingleAgent` 加参数 `modelRegistry` + `sessionModel`，决定 `--model` 时优先 glm-5.2、`agent.model==="inherit"` 时展开为 session 模型，`currentResult.model` 记录实际使用的 model；(3) 4 个调用点（single/parallel/chain + slash-command）传入 `ctx.modelRegistry` + `ctx.model`；(4) 一并补上「注入 default provider」fork patch（读 `~/.pi/agent/settings.json` 的 `defaultProvider`，注入 `--provider`，避免子进程 model resolver fallthrough 到无认证内置 provider 导致 401）——此前只存在于本机 `~/.pi/agent/extensions/subagent/index.ts`，现统一进 examples。 |
| `packages/coding-agent/test/subagent-model.test.ts` | 新增 | `resolvePreferredModel` 单元测试：defaultProvider 下可用→glm-5.2；别的 provider 下可用→undefined；不可用→undefined；defaultProvider 未知→undefined；registry undefined→undefined；多 provider 同名各自匹配。6/6 通过。 |
| `~/.pi/agent/extensions/subagent/index.ts`（本机，非 git） | 修改 | 同上逻辑同步到本机运行副本，立即生效。本机副本是旧版（缺 `/agent:<name>` slash command 注册），本次只加 glm-5.2 优先 + provider patch + inherit 解析，不补 slash command（避免扩大范围）。 |

#### 范围说明

- **仅模型选择**：不改 agent 的 tools、system prompt、执行流程。
- **不缓存**：每次派发都重新调 `getAvailable()`，模型增删/认证变化立即生效。
- **本机副本与 examples 的已知差异**：本机缺 `registerAgentSlashCommands`（旧版拷贝遗留），不影响 subagent 工具本身；如需补齐，后续另开 FEAT。

#### 冲突处理

- **`runSingleAgent` 签名被 upstream 重写** → 重新加 `modelRegistry: ModelRegistry \| undefined` + `sessionModel: { provider; id } \| undefined` 参数，并在 `--model` 决定处恢复 `resolvePreferredModel` 优先 + `inherit` 展开逻辑。
- **`ExtensionContext.modelRegistry` 被改名/移除** → 改用等价 API（如 `ctx.modelRegistry.getAvailable()`）；该字段定义在 `packages/coding-agent/src/core/extensions/types.ts` 的 `ExtensionContext`。
- **`getAvailable()` 语义变化** → `resolvePreferredModel` 改用 `find(provider, id)` + `hasConfiguredAuth()` 显式判断（本机 neolix provider 下有 glm-5.2）。
- **provider 注入 patch 被覆盖** → 在 `--model` 注入之后、`--tools` 之前重新插入读 settings.json 的 `--provider` 块。
- **本机副本 `~/.pi/agent/extensions/subagent/index.ts` 被重装覆盖** → 从 examples（本 FEAT 后）重新拷贝；注意本机副本不含 slash command，拷贝后若要 slash command 需用 examples 完整版。

#### 测试

```bash
cd packages/coding-agent
../../node_modules/.bin/tsgo -p tsconfig.examples.json   # subagent 文件 0 新增 error（2 个预存 error 在 registerAgentSlashCommands，与本改动无关）
../../node_modules/.bin/vitest --run test/subagent-model.test.ts   # 6/6 通过
```

#### 验证（行为）

派发任意 subagent（如 `subagent { agent: "scout", task: "..." }`），子进程实际用的 model 应为 `glm-5.2`（neolix），而非 agent 文件里写的 `claude-haiku-4-5`。可用临时脚本确认 `resolvePreferredModel` 在本机返回 `"glm-5.2"`（neolix 下已配置）。

---

## 模板:新增 fork feature 时照此填写

```
### FEAT-XXX - <一句话标题>

**状态**: 已实现/进行中 · **日期**: YYYY-MM-DD · **动机**: <为什么 fork 要这个>。

#### 改动文件
| 文件 | 类型 | 说明 |
|---|---|---|
| ... | 新增/修改 | ... |

#### 冲突处理
<rebase upstream 后如何恢复>

#### 测试
<如何验证>
```

<!-- 维护者注:保持本文件与实际改动同步。新增 feature 追加一节,删除 feature 删除对应节。 -->
