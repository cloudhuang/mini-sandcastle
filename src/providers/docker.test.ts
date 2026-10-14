import { test, expect } from "vitest";
import { docker } from "./docker.js";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 测试 Docker Provider 是否能正确执行命令
 * 
 * sandcastle 实际代码参考: src/sandboxes/docker.test.ts
 */
test("docker provider executes commands in container", async () => {
  // 创建临时目录作为 worktree
  const worktree = mkdtempSync(join(tmpdir(), "test-"));
  writeFileSync(join(worktree, "hello.txt"), "world");

  const provider = docker();
  
  // 创建沙箱
  const sandbox = await provider.create({
    worktreePath: worktree,
    env: {},
  });

  try {
    // 测试：读取文件
    const result = await sandbox.exec("cat /home/agent/workspace/hello.txt");
    expect(result.stdout.trim()).toBe("world");
    expect(result.exitCode).toBe(0);

    // 测试：流式输出
    const lines: string[] = [];
    await sandbox.exec("echo line1 && echo line2 && echo line3", {
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(["line1", "line2", "line3"]);

    // 测试：stdin 输入
    const stdinResult = await sandbox.exec("cat", {
      stdin: "hello from stdin",
    });
    expect(stdinResult.stdout.trim()).toBe("hello from stdin");
  } finally {
    // 关键：始终清理沙箱
    await sandbox.close();
  }
}, 60000); // 60 秒超时，因为 Docker 操作较慢

/**
 * 快照模式的 Docker 层面保障：容器不挂载任何宿主机代码目录。
 * 代码通过 docker cp 注入，容器内的写操作不会泄漏回宿主机。
 * 用 docker inspect 读取挂载列表（Docker 层面的权威信息），
 * 而不是只看 provider 代码是否传了 -v 参数。
 */
test("snapshot sandbox has zero host code mounts", async () => {
  // 创建临时目录作为快照源
  const snapshotDir = mkdtempSync(join(tmpdir(), "test-"));
  writeFileSync(join(snapshotDir, "hello.txt"), "world");

  const provider = docker();

  const sandbox = await provider.create({
    worktreePath: snapshotDir,
    env: {},
    snapshot: true,
  });

  try {
    // /etc/hostname 的内容即容器短 ID（默认主机名 = 完整 ID 前 12 位），
    // docker inspect 接受短 ID 前缀
    const hostname = await sandbox.exec("cat /etc/hostname");
    const containerId = hostname.stdout.trim();

    // docker inspect 查看容器的完整挂载列表
    const inspect = execFileSync("docker", [
      "inspect", "-f", "{{json .Mounts}}", containerId,
    ], { encoding: "utf-8" });
    const mounts = JSON.parse(inspect) as Array<{ Source: string; Destination: string }>;

    // 快照模式：不得挂载任何宿主机代码目录
    // （worktree 挂载点 /home/agent/workspace、
    //   主仓库 .git 挂载点 /home/agent/repo.git）
    const codeMounts = mounts.filter(
      (m) =>
        m.Destination === "/home/agent/workspace" ||
        m.Destination === "/home/agent/repo.git"
    );
    expect(codeMounts).toEqual([]);

    // 更强的不变量：快照源目录下任何路径都不得作为挂载源出现，
    // 即使将来 provider 换了挂载点也能兜住
    const snapshotSourceMounts = mounts.filter((m) =>
      m.Source.startsWith(snapshotDir)
    );
    expect(snapshotSourceMounts).toEqual([]);

    // 代码确实通过 docker cp 注入到了容器里
    const cat = await sandbox.exec("cat /home/agent/workspace/hello.txt");
    expect(cat.stdout.trim()).toBe("world");

    // 容器内的写操作不会出现在宿主机快照目录（无 bind mount 泄漏）
    await sandbox.exec("echo leaked > /home/agent/workspace/leaked.txt");
    expect(existsSync(join(snapshotDir, "leaked.txt"))).toBe(false);
  } finally {
    await sandbox.close();
  }
}, 60000);