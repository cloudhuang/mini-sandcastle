# mini-sandcastle

A minimal TypeScript orchestrator for running AI agents (Claude Code) in Docker sandboxes against git worktrees.

This is a simplified, educational version of the [sandcastle](https://github.com/anthropics/sandcastle) system used at Anthropic to run Claude Code on isolated branches with full sandboxing.

## What It Does

1. **Creates a git worktree** for an isolated branch
2. **Spawns a Docker container** with the worktree mounted
3. **Runs Claude Code** in non-interactive (`--print`) mode with a given prompt
4. **Streams output** in real-time (text, tool calls, results)
5. **Captures commits** made by the agent
6. **Cleans up** the sandbox automatically (preserves worktree if there are uncommitted changes)

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Git Worktree  │────▶│Docker Sandbox│────▶│  Claude Code    │
│(isolated branch)│────▶│ (container)  │────▶│  (agent)        │
└─────────────────┘     └──────────────┘     └─────────────────┘
```

### Core Components

| File | Purpose |
|------|---------|
| `src/run.ts` | Main orchestration: worktree → sandbox → agent → commits → cleanup |
| `src/run-parallel.ts` | Parallel task execution with semaphore-based concurrency control |
| `src/types.ts` | Core interfaces (`SandboxProvider`, `AgentProvider`, `ExecOptions`, etc.) |
| `src/agents/claude.ts` | Claude Code agent provider: builds print-mode commands, parses JSONL output |
| `src/providers/docker.ts` | Docker sandbox provider: container lifecycle, exec with streaming |
| `src/utils/worktree.ts` | Git worktree creation, removal, and orphan cleanup |
| `src/utils/semaphore.ts` | Zero-dependency semaphore for controlling parallel task count |
| `src/utils/shutdown.ts` | Process shutdown registry for cleaning up sandboxes on SIGINT/SIGTERM |
| `src/utils/prompt.ts` | Prompt file loader with `{{VARIABLE}}` substitution |

### Tests

| File | Purpose |
|------|---------|
| `src/providers/docker.test.ts` | Docker sandbox provider integration tests |
| `src/utils/worktree.test.ts` | Git worktree creation and change-detection tests |
| `test/readme.test.ts` | README structure and content assertions |

### Scripts

| File | Purpose |
|------|---------|
| `scripts/test-shutdown.ts` | Manual test for the shutdown registry signal handling |

### Agent Output Format

Claude Code outputs JSON Lines (JSONL). Each line is a JSON object:

```json
{"type":"text","text":"Analyzing code..."}
{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}
{"type":"result","result":"Task completed"}
```

The agent provider parses these into typed events (`text`, `tool_call`, `result`, `session_id`).

## Running Tests

```bash
# Install dependencies
npm install

# Run tests
npm run test

# Type check
npm run typecheck

# Build
npm run build
```

## Running the Sandbox

```bash
# Build the Docker image first
docker build -t mini-sandcastle-image -f .sandcastle/Dockerfile .

# Run a single task
npm run sandcastle

# Or use the parallel runner
npx tsx .sandcastle/test-parallel.ts
```

## Design Notes

- **Why worktrees?** Each issue gets an isolated branch without interfering with the main working directory. Worktrees can be checked out in parallel.
- **Why stdin for prompts?** Linux has an `ARG_MAX` limit (~128KB). Large prompts passed as arguments fail with `E2BIG`; stdin bypasses this.
- **Why a shutdown registry?** Multiple concurrent sandboxes would each register SIGINT listeners, triggering `MaxListenersExceededWarning`. A unified registry also ensures synchronous cleanup (async operations are unsafe in signal handlers).
- **Why preserve dirty worktrees?** If an agent crashes leaving uncommitted changes, the worktree is kept for manual inspection instead of being deleted.
