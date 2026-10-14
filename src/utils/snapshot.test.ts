import { test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createSnapshot, removeSnapshot, snapshotExists } from "./snapshot.js";

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

test("create and remove snapshot", () => {
    const repo = createTestRepo();

    const snapshot = createSnapshot(repo);

    // 验证快照目录存在且是独立的完整 clone
    expect(snapshotExists(snapshot)).toBe(true);
    expect(existsSync(join(snapshot.path, ".git"))).toBe(true);
    const log = execSync("git log --format=%s", { cwd: snapshot.path, encoding: "utf-8" });
    expect(log).toContain("init");

    // 清理
    removeSnapshot(snapshot);
    expect(snapshotExists(snapshot)).toBe(false);
});

test("snapshot is isolated from host repo", () => {
    const repo = createTestRepo();
    const snapshot = createSnapshot(repo);

    // 快照里的写操作不影响宿主仓库（clone 不带 local git config，先补身份）
    execSync('git config user.email "test@test.com"', { cwd: snapshot.path });
    execSync('git config user.name "Test"', { cwd: snapshot.path });
    writeFileSync(join(snapshot.path, "scratch.txt"), "sandbox only");
    execSync("git add .", { cwd: snapshot.path });
    execSync('git commit -m "sandbox commit"', { cwd: snapshot.path });

    const hostLog = execSync("git log --format=%s", { cwd: repo, encoding: "utf-8" });
    expect(hostLog).not.toContain("sandbox commit");
    expect(hostLog.trim().split("\n")).toHaveLength(1);

    // 快照不注册进宿主仓库的 git 元数据（无 worktree、无远端变化）
    const remotes = execSync("git remote", { cwd: repo, encoding: "utf-8" });
    expect(remotes.trim()).toBe("");

    removeSnapshot(snapshot);
});

test("createSnapshot cleans up temp dir when git clone fails", () => {
    // 统计克隆前的快照临时目录数量
    const before = countSnapshotDirs();

    // 不存在的仓库路径会导致 git clone 失败
    expect(() => createSnapshot(join(tmpdir(), "no-such-repo-xyz"))).toThrow();

    // 失败不应泄漏 mini-sandcastle-snapshot-* 目录
    const leaked = countSnapshotDirs();
    expect(leaked).toBe(before);
});

function countSnapshotDirs(): number {
    return readdirSync(tmpdir()).filter((f) => f.startsWith("mini-sandcastle-snapshot-")).length;
}

test("snapshot restores origin URL from host repo", () => {
    const repo = createTestRepo();
    execSync("git remote add origin https://github.com/test/repo.git", { cwd: repo });

    const snapshot = createSnapshot(repo);

    const originUrl = execSync("git remote get-url origin", {
        cwd: snapshot.path,
        encoding: "utf-8",
    }).trim();
    expect(originUrl).toBe("https://github.com/test/repo.git");

    removeSnapshot(snapshot);
});
