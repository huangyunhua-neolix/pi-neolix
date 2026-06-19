# Fork Change Log — pi-neolix

> 本文件记录 **pi-neolix** fork 相对 upstream(pi 官方仓库)的**自定义源码改动**。
>
> 每次 `git pull` / `rebase` / `merge` upstream 后,按本文件核对改动是否保留;
> 新增 fork feature 时,在「改动清单」追加一节,格式见模板。
>
> - **Fork 仓库**: `huangyunhua-neolix/pi-neolix`
> - **Upstream**: pi 官方仓库(分支 `main`)
> - **当前 fork 基线**: `7a14325b` (feat(tui): detect Warp terminal and enable Kitty image protocol (#5841), 2026-06-18)

---

## 与 upstream 同步的工作流

1. `git fetch <upstream> main`
2. `git rebase <upstream>/main`(或 merge)
3. 若下列文件出现冲突 / 被上游改动覆盖,按对应章节的「冲突处理」恢复:
   - `packages/coding-agent/src/core/web-bridge.ts` — **新增文件**,upstream 不会有同名冲突,除非上游也加了 `web-bridge.ts`。
   - `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — 4 处接线点,见下文「接入位置」。
   - `packages/coding-agent/test/web-bridge.test.ts` — 新增测试文件。
4. 同步后跑 `npm run check`(coding-agent)和 `web-bridge` 的单测,确认改动仍生效。
5. 如果 fork feature 已被 upstream 以等价方式实现,删除本文件对应章节并改为引用 upstream 实现。

> 数据文件不算自定义改动:`packages/ai/src/models.generated.ts`、
> `packages/ai/src/image-models.generated.ts` 跟随 upstream 重新生成即可
> (见 `AGENTS.md`:改 `generate-models.ts` 后 regenerate),同步时直接采纳上游版本。
> `packages/ai/package.json` 多出的 `@smithy/types` 依赖若是 fork 引入需保留,
> 否则按上游。

---

## 改动清单

### FEAT-001 — Web Adapter 信号桥(OSC 9998 / 9999)

**状态**: 已实现 · **日期**: 2026-06-19 · **动机**: 让 pi 在 freecode-web 适配器下,会话状态 / 计费 / context 跟 freecode 一样准确(否则 web UI 全显示 "—")。

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
**裸终端运行 pi 时完全静默**——OSC 对普通终端是不可见的(未知 OSC 被吞),
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
而非一直显示 "—"。autoupdate 的 subagent gate 也会因 `agents=1` 在 turn 中阻塞安装。

---

## 模板:新增 fork feature 时照此填写

```
### FEAT-XXX — <一句话标题>

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
