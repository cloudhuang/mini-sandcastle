import type { AgentProvider, SandboxProvider } from "./types.js";
import { readFileSync } from "node:fs";
import { createWorktree, removeWorktree, hasUncommittedChanges } from "./utils/worktree.js";
import { createSnapshot, removeSnapshot } from "./utils/snapshot.js";

/**
 * 运行选项
 * sandcastle 实际代码参考: src/createSandbox.ts (SandboxRunOptions)
 */
export interface RunOptions {
    readonly name?: string;
    readonly prompt: string;
    readonly repoDir: string;
    /**
     * 任务分支；worktree 模式默认 sandcastle/run，
     * snapshot 模式下不创建分支，此参数忽略
     */
    readonly branch?: string;
    readonly agent: AgentProvider;
    readonly sandbox: SandboxProvider;
    readonly baseBranch?: string;
    /**
     * 快照模式（Plan 阶段专用）：
     * 不创建 worktree，而是把仓库 clone 到临时快照目录，
     * 沙箱内不挂载任何宿主机代码目录（认证缓存除外），Agent 结束后快照整个丢弃。
     * Agent 的产出仅是 stdout（如 <plan> JSON），不产生 commit。
     */
    readonly snapshot?: boolean;
}

/**
 * 运行结果
 */
export interface RunResult {
    readonly stdout: string;
    readonly exitCode: number;
    readonly commits: string[];
}

/**
 * 单次运行 Agent
 * 
 * 这是 sandcastle 最核心的编排逻辑简化版
 * sandcastle 实际代码参考: src/Orchestrator.ts (invokeAgent) + src/createSandbox.ts
 *
 * 两种模式：
 * - worktree（默认）：创建分支 + worktree + bind mount，Agent 的 commit 落回任务分支
 * - snapshot（Plan 等只读阶段）：临时 clone + docker cp，无宿主机挂载，产出只有 stdout
 */
export async function run(options: RunOptions): Promise<RunResult> {
    if (options.snapshot) {
        return runInSnapshot(options);
    }

    const branch = options.branch ?? "sandcastle/run";

    console.log(`\n🚀 Running agent on branch: ${branch}`);

    // Step 1: 创建 worktree
    const worktree = createWorktree(
        options.repoDir,
        branch,
        options.baseBranch
    );

    let sandbox: Awaited<ReturnType<SandboxProvider["create"]>> | undefined;

    try {
        // Step 2: 创建沙箱
        sandbox = await options.sandbox.create({
            worktreePath: worktree.path,
            repoDir: options.repoDir,
            env: {
                HOME: "/home/agent",
                ...pickAgentEnvVars(),
            },
        });

        // Step 3+4: 执行 Agent
        const { stdout, exitCode } = await execAgent(sandbox, options);

        // Step 5: 提取 commits
        const commits = await getCommits(worktree.path);

        return {
            stdout,
            exitCode,
            commits,
        };
    } finally {
        // Step 6: 清理（关键！）
        if (sandbox) {
            await sandbox.close();
        }

        // 如果有未提交变更，保留 worktree 供审查
        if (hasUncommittedChanges(worktree.path)) {
            console.log(`\n⚠️  Worktree preserved (uncommitted changes): ${worktree.path}`);
        } else {
            removeWorktree(worktree);
        }
    }
}

/**
 * 快照模式运行（Plan 阶段）
 *
 * 与 worktree 模式的差异：
 * 1. 不创建分支/worktree，而是把仓库 clone 到系统临时目录
 * 2. 沙箱内不挂载任何宿主机代码目录（认证缓存除外，代码由 docker cp 拷入容器）
 * 3. Agent 结束后快照整个删除，commits 恒为空
 */
async function runInSnapshot(options: RunOptions): Promise<RunResult> {
    console.log(`\n🚀 Running agent in snapshot sandbox${options.name ? `: ${options.name}` : ""}`);

    // Step 1: 创建一次性仓库快照（完整 clone，含可用的 .git）
    const snapshot = createSnapshot(options.repoDir);

    let sandbox: Awaited<ReturnType<SandboxProvider["create"]>> | undefined;

    try {
        // Step 2: 创建沙箱（snapshot: true —— 无宿主机代码挂载）
        sandbox = await options.sandbox.create({
            worktreePath: snapshot.path,
            env: {
                HOME: "/home/agent",
                ...pickAgentEnvVars(),
            },
            snapshot: true,
        });

        // Step 3+4: 执行 Agent
        const { stdout, exitCode } = await execAgent(sandbox, options);

        // 快照模式不产 commit：Agent 的产出就是 stdout（如 <plan> JSON）
        return {
            stdout,
            exitCode,
            commits: [],
        };
    } finally {
        // Step 5: 清理容器与快照
        if (sandbox) {
            await sandbox.close();
        }
        removeSnapshot(snapshot);
    }
}

/**
 * 在已创建的沙箱中执行 Agent 命令
 * 收集纯文本输出（而非原始 JSON Lines），便于下游正则匹配
 */
async function execAgent(
    sandbox: Awaited<ReturnType<SandboxProvider["create"]>>,
    options: RunOptions,
): Promise<{ stdout: string; exitCode: number }> {
    // 构建 Agent 命令
    const printCmd = options.agent.buildPrintCommand({
        prompt: options.prompt,
    });

    console.log(`   Agent: ${options.agent.name}`);
    console.log(`   Command: ${printCmd.command.slice(0, 80)}...`);

    const textChunks: string[] = [];

    // 执行 Agent（设置 10 分钟超时，避免 pi 等慢 agent 被中断）
    const result = await sandbox.exec(printCmd.command, {
        onLine: (line) => {
            // 实时解析并显示
            for (const event of options.agent.parseStreamLine(line)) {
                switch (event.type) {
                    case "text":
                        process.stdout.write(event.text);
                        textChunks.push(event.text);
                        break;
                    case "tool_call":
                        console.log(`\n   [Tool: ${event.name}] ${event.args}\n`);
                        break;
                    case "result":
                        console.log(`\n   [Result] ${event.result}\n`);
                        break;
                }
            }
        },
        cwd: "/home/agent/workspace",
        stdin: printCmd.stdin,
        timeout: 600_000, // 10 分钟
    });

    return { stdout: textChunks.join(""), exitCode: result.exitCode };
}

/**
 * 从宿主环境提取 Agent 需要的 API key 环境变量
 */
function pickAgentEnvVars(): Record<string, string> {
    const keys = [
        "GH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "GEMINI_API_KEY",
        "GROQ_API_KEY",
        "CEREBRAS_API_KEY",
        "XAI_API_KEY",
        "FIREWORKS_API_KEY",
        "TOGETHER_API_KEY",
        "OPENROUTER_API_KEY",
        "AI_GATEWAY_API_KEY",
        "MISTRAL_API_KEY",
        "MINIMAX_API_KEY",
        "MOONSHOT_API_KEY",
        "KIMI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_ACCOUNT_ID",
    ];
    const env: Record<string, string> = {};
    for (const key of keys) {
        const value = process.env[key];
        if (value) env[key] = value;
    }

    // 读取 Pi 的 auth.json，把 API key 映射为环境变量
    try {
        const piAuthPath = `${process.env.HOME ?? "/root"}/.pi/agent/auth.json`;
        const auth = JSON.parse(readFileSync(piAuthPath, "utf-8")) as Record<
            string,
            { type: string; key?: string }
        >;
        for (const [provider, creds] of Object.entries(auth)) {
            if (creds.type === "api_key" && creds.key) {
                const envVar = piProviderToEnvVar(provider);
                if (envVar && !env[envVar]) {
                    env[envVar] = creds.key;
                }
            }
        }
    } catch {
        // auth.json 不存在或解析失败，忽略
    }

    return env;
}

/**
 * Pi provider 名称 → 环境变量名映射
 */
function piProviderToEnvVar(provider: string): string | undefined {
    const map: Record<string, string> = {
        "kimi-coding": "KIMI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        "azure-openai": "AZURE_OPENAI_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
        gemini: "GEMINI_API_KEY",
        groq: "GROQ_API_KEY",
        cerebras: "CEREBRAS_API_KEY",
        xai: "XAI_API_KEY",
        fireworks: "FIREWORKS_API_KEY",
        "together-ai": "TOGETHER_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        mistral: "MISTRAL_API_KEY",
        minimax: "MINIMAX_API_KEY",
        moonshot: "MOONSHOT_API_KEY",
        bedrock: "AWS_ACCESS_KEY_ID",
        cloudflare: "CLOUDFLARE_API_KEY",
    };
    return map[provider];
}

/**
 * 获取分支上的 commits
 */
async function getCommits(worktreePath: string): Promise<string[]> {
    const { execSync } = await import("node:child_process");
    try {
        const output = execSync("git log --format=%H -n 10", {
            cwd: worktreePath,
            encoding: "utf-8",
        });
        return output.trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}