import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
        execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "ignore" });
    } catch {
        execSync('git commit --allow-empty -m "Initial commit"', { cwd: repoDir });
    }
}

export function createWorktree(
    repoDir: string,
    branch: string,
    baseBranch: string = "HEAD"
): Worktree {
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
    try {
        execSync(`git show-ref --verify --quiet refs/heads/${branch}`, {
            cwd: repoDir,
        });
        // 分支已存在，直接添加 worktree
        execSync(`git worktree add "${worktreePath}" "${branch}"`, {
            cwd: repoDir,
        });
    } catch {
        // 分支不存在，从 baseBranch 创建
        execSync(`git worktree add -B "${branch}" "${worktreePath}" "${baseBranch}"`, {
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
        execSync(`git worktree remove --force "${worktree.path}"`, {
            cwd: worktree.repoDir,
            stdio: "pipe",
        });
    } catch {
        // .git 文件可能被容器内操作破坏，git worktree remove 会失败
        // 直接 rm -rf 然后 prune 清理注册表
    }

    // 无论 git worktree remove 是否成功，都确保目录被删除
    try {
        execSync(`rm -rf "${worktree.path}"`);
    } catch {
        // 忽略
    }

    // 清理 git 的 worktree 记录
    try {
        execSync("git worktree prune", { cwd: worktree.repoDir, stdio: "pipe" });
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
        const status = execSync("git status --porcelain", {
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
    return execSync("git branch --show-current", {
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
        execSync("git worktree prune", { cwd: repoDir });
    } catch {
        // 忽略错误
    }
}