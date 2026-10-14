# mini-sandcastle

[Anthropic sandcastle](https://github.com/anthropics/sandcastle) 的迷你复刻：用**零运行时依赖**的 TypeScript，在 Docker 沙箱里并行运行多个 CLI 编码 Agent（Claude Code / Pi），每个任务在独立的 git worktree 分支上自主完成工作。

> 这是一个学习型项目。代码注释中标注了与 sandcastle 真实实现的对应关系（`src/SandboxProvider.ts`、`src/Orchestrator.ts` 等），方便对照原仓库理解架构。

## 架构

```
┌─────────────────────────────────────────────┐
│  编排层  src/run.ts / src/run-parallel.ts    │
│  worktree → 沙箱 → Agent → 提取 commits     │
└────────────────┬────────────────────────────┘
        ┌────────┴─────────┐
        ▼                  ▼
┌───────────────┐   ┌───────────────┐
│ SandboxProvider│  │ AgentProvider  │
│  providers/docker │  │ agents/claude | agents/pi
└───────────────┘   └───────────────┘
```

两个正交的抽象（定义见 `src/types.ts`）：

- **`SandboxProvider`** — 隔离的执行环境。目前有 Docker 实现（`src/providers/docker.ts`）。
- **`AgentProvider`** — 把不同 CLI Agent 的差异收敛为 `buildPrintCommand` + `parseStreamLine` 两个方法。新增 Agent（如 Codex、Cursor CLI）只需实现这个接口，无需改动核心编排逻辑。

## 核心流程（`src/run.ts`）

1. **创建 worktree**：每个任务在 `.sandcastle/worktrees/<branch>` 有独立工作区，多任务可并行 checkout 不同分支
2. **创建沙箱**：`docker run` 启动容器，挂载 worktree、`.git`、`~/.claude` 认证缓存，注入 API key 环境变量
3. **构建命令**：prompt 大于 ARG_MAX（~128KB）时通过 stdin 传入
4. **流式执行**：stdout 逐行回调 → `parseStreamLine` 解析为统一事件（text / tool_call / result / session_id）
5. **提取 commits**：读取任务分支上新增的提交
6. **清理**：关容器、删 worktree；若 Agent 留下未提交变更则保留 worktree 供审查

并行编排见 `src/run-parallel.ts`：手写信号量（`src/utils/semaphore.ts`）控制并发上限，`Promise.allSettled` 保证单任务失败不影响整批。

## 使用

```bash
# 前置：Docker Desktop、构建沙箱镜像
docker build -t mini-sandcastle-image -f .sandcastle/Dockerfile .sandcastle

# 单次运行（.sandcastle/main.ts 是一个完整示例）
npm run sandcastle
```

通过环境变量选择 Agent 与模型（与 `.sandcastle/main.ts` 一致）：

```bash
AGENT=pi npm run sandcastle          # 默认：Pi Agent
AGENT=claude npm run sandcastle      # Claude Code
MODEL=kimi-for-coding npm run sandcastle  # 可选，指定模型
```

进程收到 SIGINT/SIGTERM 时，`src/utils/shutdown.ts` 的 Shutdown Registry 会同步清理所有容器（信号处理器中只能执行同步操作）。

## 已知坑：容器内 git 可能污染宿主机 `.git/config`

Docker provider 挂载了主仓库的 `.git`（为了让容器内 git 可用），沙箱内的 Agent 有可能把容器路径（`/home/agent/workspace`）写进 `core.worktree`，导致宿主机 git 报错：

```
fatal: Invalid path '/System/Volumes/Data/home/agent': No such file or directory
```

`GIT_CONFIG_GLOBAL=/dev/null` 只能隔离全局配置，防不住仓库级 `.git/config`。`src/utils/worktree.ts` 中的 `repairPollutedGitConfig()` 会在每次创建 worktree 时自动检测并移除此类污染。

## 开发

```bash
npm test         # vitest（worktree 测试无需 Docker；docker.test.ts 需要）
npm run typecheck
npm run build    # tsup
```

调试 Agent 事件流解析可用根目录的 `test-parse.mjs`（直接喂一行 JSON 给 `parseStreamLine` 观察输出）：

```bash
node test-parse.mjs
```