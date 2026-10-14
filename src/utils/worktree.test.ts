import { test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createWorktree, removeWorktree, hasUncommittedChanges, getCurrentBranch } from "./worktree.js";

// 关键：清除可能从沙箱环境泄漏的 GIT_* 环境变量。
// 当本测试在 Docker 沙箱内被 agent 运行时（implement/review/merge prompt
// 都会跑 npm test），这些变量会把测试对临时仓库的 git 操作
// 重定向到挂载的真实仓库，破坏仓库元数据。
for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]) {
    delete process.env[key];
}

/**
 * 创建临时 git 仓库用于测试
 */
function createTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "git-test-"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# Test");
    execSync("git add .", { cwd: dir });
    execSync('git commit -m "init"', { cwd: dir });
    return dir;
}

test("create and remove worktree", () => {
    const repo = createTestRepo();

    const worktree = createWorktree(repo, "feature/test-branch");

    // 验证 worktree 目录存在
    expect(worktree.path).toContain("feature/test-branch");

    // 验证分支创建成功
    const branches = execSync("git branch", { cwd: repo, encoding: "utf-8" });
    expect(branches).toContain("feature/test-branch");

    // 清理
    removeWorktree(worktree);
});

test("detect uncommitted changes", () => {
    const repo = createTestRepo();
    const worktree = createWorktree(repo, "feature/dirty");

    // 初始状态：干净
    expect(hasUncommittedChanges(worktree.path)).toBe(false);

    // 创建未提交的文件
    writeFileSync(join(worktree.path, "new-file.txt"), "content");

    // 现在脏了
    expect(hasUncommittedChanges(worktree.path)).toBe(true);

    removeWorktree(worktree);
});