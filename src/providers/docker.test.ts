import { test, expect } from "vitest";
import { docker } from "./docker.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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