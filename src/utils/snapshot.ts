import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 仓库快照信息
 *
 * 与 worktree 的区别：快照是仓库的独立临时副本（完整 clone），
 * 不注册进宿主仓库的 git 元数据，运行完直接整个删除。
 * 用于 Plan 等只读场景：Agent 的产出是 stdout 里的计划，
 * 不需要（也不应该）向宿主仓库提交任何 commit。
 */
export interface Snapshot {
    readonly path: string;
}

/**
 * 创建仓库快照
 *
 * 用本地 clone 获得一个独立且功能完整的 .git，
 * 容器内 git/gh 可以正常工作，但所有写操作都落在临时目录里，
 * 宿主仓库零接触（无 worktree 注册、无 .git 挂载）。
 *
 * clone 会把 origin 指回本地路径，导致容器内 gh 无法推断 GitHub 仓库，
 * 因此把 origin 还原为宿主仓库的远端 URL。
 */
export function createSnapshot(repoDir: string): Snapshot {
    const path = mkdtempSync(join(tmpdir(), "mini-sandcastle-snapshot-"));

    try {
        execFileSync("git", ["clone", "--quiet", repoDir, path]);
    } catch (error) {
        // clone 失败时清理临时目录，避免泄漏
        try {
            rmSync(path, { recursive: true, force: true });
        } catch {
            // 忽略清理失败
        }
        throw error;
    }

    try {
        const originUrl = execFileSync(
            "git", ["remote", "get-url", "origin"],
            { cwd: repoDir, encoding: "utf-8" },
        ).trim();
        if (originUrl) {
            execFileSync("git", ["remote", "set-url", "origin", originUrl], { cwd: path });
        }
    } catch {
        // 宿主仓库没有远端，忽略
    }

    return { path };
}

/**
 * 删除仓库快照
 */
export function removeSnapshot(snapshot: Snapshot): void {
    try {
        rmSync(snapshot.path, { recursive: true, force: true });
    } catch {
        // 忽略
    }
}

/**
 * 检查快照目录是否仍然存在（主要用于测试断言）
 */
export function snapshotExists(snapshot: Snapshot): boolean {
    return existsSync(snapshot.path);
}
