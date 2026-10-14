import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Worktree 信息
 * sandcastle 实际代码参考: src/WorktreeManager.ts
 */
export interface Worktree {
    readonly path: string;
    readonly branch: string;
    readonly repoDir: string;
}

/**
 * 创建 git worktree
 *
 * 为什么用 worktree？
 * 1. 每个 issue 独立分支，互不干扰
 * 2. 可以并行 checkout 多个分支
 * 3. 自动清理，不会污染主工作区
 *
 * GitHub Issue 参考: #674（孤儿 worktree 清理）
 */
/**
 * 确保仓库至少有一个提交，否则 worktree 无法基于 HEAD 创建
 */
function ensureRepoHasCommit(repoDir: string): void {
    try {
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "ignore" });
    } catch {
        execFileSync("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd: repoDir });
    }
}

export function createWorktree(
    repoDir: string,
    branch: string,
    baseBranch: string = "HEAD"
): Worktree {
    // 先修复可能被沙箱内 Agent 污染的 .git/config
    repairPollutedGitConfig(repoDir);

    // 空仓库没有 HEAD，先创建一个初始提交
    ensureRepoHasCommit(repoDir);

    // 确保 .sandcastle/worktrees 目录存在
    const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
    if (!existsSync(worktreesDir)) {
        mkdirSync(worktreesDir, { recursive: true });
    }

    const worktreePath = join(worktreesDir, branch);

    // 如果 worktree 目录已存在（上次未清理），直接复用
    if (existsSync(worktreePath)) {
        return { path: worktreePath, branch, repoDir };
    }

    // 检查分支是否已存在
    // 注意：全部使用 execFileSync 数组参数，杜绝 shell 注入
    try {
        execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
            cwd: repoDir,
            stdio: "ignore",
        });
        // 分支已存在，直接添加 worktree
        execFileSync("git", ["worktree", "add", worktreePath, branch], {
            cwd: repoDir,
        });
    } catch {
        // 分支不存在，从 baseBranch 创建
        execFileSync("git", ["worktree", "add", "-B", branch, worktreePath, baseBranch], {
            cwd: repoDir,
        });
    }

    return { path: worktreePath, branch, repoDir };
}

/**
 * 删除 worktree
 */
export function removeWorktree(worktree: Worktree): void {
    try {
        execFileSync("git", ["worktree", "remove", "--force", worktree.path], {
            cwd: worktree.repoDir,
            stdio: "pipe",
        });
    } catch {
        // .git 文件可能被容器内操作破坏，git worktree remove 会失败
        // 直接 rmSync 然后 prune 清理注册表
    }

    // 无论 git worktree remove 是否成功，都确保目录被删除
    try {
        rmSync(worktree.path, { recursive: true, force: true });
    } catch {
        // 忽略
    }

    // 清理 git 的 worktree 记录
    try {
        execFileSync("git", ["worktree", "prune"], { cwd: worktree.repoDir, stdio: "pipe" });
    } catch {
        // 忽略
    }
}

/**
 * 检查是否有未提交的变更
 *
 * sandcastle 实际代码参考: src/WorktreeManager.ts (hasUncommittedChanges)
 *
 * 为什么重要？如果 Agent 崩溃留下未提交的代码，
 * 保留 worktree 让用户可以查看。
 */
export function hasUncommittedChanges(worktreePath: string): boolean {
    try {
        const status = execFileSync("git", ["status", "--porcelain"], {
            cwd: worktreePath,
            encoding: "utf-8",
        });
        return status.trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * 获取当前分支
 */
export function getCurrentBranch(repoDir: string): string {
    return execFileSync("git", ["branch", "--show-current"], {
        cwd: repoDir,
        encoding: "utf-8",
    }).trim();
}

/**
 * 清理孤儿 worktree
 *
 * GitHub Issue 参考: #674
 * 当 sandbox 创建失败时（如镜像不存在），
 * worktree 可能残留。启动时清理。
 */
export function pruneStaleWorktrees(repoDir: string): void {
    try {
        execFileSync("git", ["worktree", "prune"], { cwd: repoDir });
    } catch {
        // 忽略错误
    }
}

/**
 * 修复被沙箱内 Agent 污染的 .git/config
 *
 * 问题背景：容器内的 .git 通过 bind mount 直连宿主机仓库（repo.git），
 * Agent 在容器内执行 git 操作时可能把容器内路径（如 /home/agent/workspace）
 * 写入 core.worktree。这会让宿主机的 git 彻底失效：
 *   fatal: Invalid path '/System/Volumes/Data/home/agent': No such file or directory
 *
 * 注意：GIT_CONFIG_GLOBAL=/dev/null 只能隔离全局配置，
 * 仓库级 .git/config 仍然是可写的，所以需要主动检测并修复。
 */
export function repairPollutedGitConfig(repoDir: string): void {
    const configPath = join(repoDir, ".git", "config");
    let content: string;
    try {
        content = readFileSync(configPath, "utf-8");
    } catch {
        return; // .git/config 不存在（bare 仓库等），跳过
    }

    const lines = content.split("\n");
    const cleaned: string[] = [];
    let removed = false;

    // 只要 core.worktree 指向容器内路径（/home/agent），在宿主机上必然是非法配置，
    // 不做段落判断，直接移除
    for (const line of lines) {
        if (/^\s*worktree\s*=\s*\/home\/agent(\/|$)/.test(line)) {
            removed = true;
            continue;
        }
        cleaned.push(line);
    }

    if (removed) {
        console.warn(
            `⚠️  Detected polluted core.worktree (container path) in ${configPath}, removed it.`
        );
        writeFileSync(configPath, cleaned.join("\n"));
    }
}