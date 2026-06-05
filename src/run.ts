import type { AgentProvider, SandboxProvider } from "./types.js";
import { createWorktree, removeWorktree, hasUncommittedChanges } from "./utils/worktree.js";

/**
 * 运行选项
 * sandcastle 实际代码参考: src/createSandbox.ts (SandboxRunOptions)
 */
export interface RunOptions {
    readonly name?: string;
    readonly prompt: string;
    readonly repoDir: string;
    readonly branch: string;
    readonly agent: AgentProvider;
    readonly sandbox: SandboxProvider;
    readonly baseBranch?: string;
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
 */
export async function run(options: RunOptions): Promise<RunResult> {
    console.log(`\n🚀 Running agent on branch: ${options.branch}`);

    // Step 1: 创建 worktree
    const worktree = createWorktree(
        options.repoDir,
        options.branch,
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
                ...(process.env.ANTHROPIC_API_KEY
                    ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
                    : {}),
            },
        });

        // Step 3: 构建 Agent 命令
        const printCmd = options.agent.buildPrintCommand({
            prompt: options.prompt,
        });

        console.log(`   Agent: ${options.agent.name}`);
        console.log(`   Command: ${printCmd.command.slice(0, 80)}...`);

        // Step 4: 执行 Agent
        // 收集纯文本输出（而非原始 JSON Lines），便于下游正则匹配
        const textChunks: string[] = [];

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
        });

        // Step 5: 提取 commits
        const commits = await getCommits(worktree.path);

        return {
            stdout: textChunks.join(""),
            exitCode: result.exitCode,
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