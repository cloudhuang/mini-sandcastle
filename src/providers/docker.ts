import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { homedir, userInfo } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxProvider, SandboxHandle, CreateSandboxOptions, ExecOptions, ExecResult } from "../types.js";
import { registerShutdown } from "../utils/shutdown.js";

/**
 * Docker 沙箱 Provider
 * 
 * sandcastle 实际代码参考: src/sandboxes/docker.ts
 * 关键差异：sandcastle 用 Effect 封装，我们这里用原始 Promise 便于理解
 */
export const docker = (): SandboxProvider => ({
    name: "docker",

    // 在 create 方法中，启动容器后注册清理：
    async create(options: CreateSandboxOptions): Promise<SandboxHandle> {
        const containerName = `mini-sandcastle-${randomUUID()}`;
        const imageName = "mini-sandcastle-image";

        await dockerRun(containerName, imageName, options.repoDir, options.worktreePath, options.env);

        // 计算容器内的 GIT_DIR：必须指向 worktree 自己的 admin 目录，
        // 而不是主仓库 .git —— 否则容器内 git commit 会落到主仓库当前
        // checkout 的分支上，彻底破坏多任务分支隔离
        const gitDirInContainer = resolveContainerGitDir(options.worktreePath);

        // 注册同步清理函数
        // 关键：信号处理器中只能用同步操作！
        const removeContainerSync = () => {
            try {
                execFileSync("docker", ["rm", "-f", containerName], {
                    stdio: "ignore",
                });
            } catch {
                // 最佳努力
            }
        };
        const unregisterShutdown = registerShutdown(removeContainerSync);

        return {
            worktreePath: "/home/agent/workspace",

            async exec(command, opts) {
                return dockerExec(containerName, command, opts, gitDirInContainer);
            },

            async close() {
                unregisterShutdown(); // 正常关闭时注销信号处理器
                await dockerRemove(containerName);
            },
        };
    }
});

/**
 * docker run -d --name <name> -v <worktree>:/home/agent/workspace <image>
 *
 * 注意：镜像的 ENTRYPOINT 已经是 "sleep infinity"，这里不要再传命令，
 * 否则会拼接成 "sleep infinity sleep infinity" 导致容器启动失败。
 */
async function dockerRun(
    name: string,
    image: string,
    repoDir: string | undefined,
    worktreePath: string,
    env: Record<string, string>
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = [
            "run",
            "-d",                    // 后台运行
            "--name", name,          // 指定容器名
            "-v", `${worktreePath}:/home/agent/workspace`, // 代码挂载
        ];

        // 挂载主仓库 .git，使容器内 git 能正确识别 worktree
        if (repoDir) {
            args.push("-v", `${repoDir}/.git:/home/agent/repo.git`);
        }

        args.push("-v", `${homedir()}/.claude:/home/agent/.claude`); // 认证缓存挂载
        // Pi 的认证（auth.json，含 oauth 类型的凭据）也挂载进容器
        if (existsSync(join(homedir(), ".pi"))) {
            args.push("-v", `${homedir()}/.pi:/home/agent/.pi`);
        }
        args.push("-w", "/home/agent/workspace"); // 工作目录

        // 注入所有环境变量
        for (const [key, value] of Object.entries(env)) {
            args.push("-e", `${key}=${value}`);
        }

        // 使用宿主机 UID/GID 运行容器，确保能读取挂载的认证文件（如 ~/.claude/.credentials.json）
        const { uid, gid } = userInfo();
        args.push("--user", `${uid}:${gid}`);

        args.push(image);

        const proc = spawn("docker", args);

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        proc.on("close", (code) => {
            if (code === 0) {
                console.log(`Container started: ${name}`);
                resolve();
            } else {
                reject(new Error(`docker run failed with code ${code}: ${stderr || stdout}"`));
            }
        });

        proc.on("error", (err) => {
            reject(new Error(`docker run error: ${err.message}`));
        });
    });
}

/**
 * 解析容器内应使用的 GIT_DIR
 *
 * worktree 的 git admin 目录形如 <repo>/.git/worktrees/<name>，
 * 其中的 HEAD 指向任务分支。把它挂载路径换算到容器内
 * （主仓库 .git 已挂载到 /home/agent/repo.git），
 * 容器内的 git add/commit 就会落到任务分支上。
 *
 * 如果 worktreePath 不是 git worktree（比如普通目录），回退到主 .git。
 */
function resolveContainerGitDir(worktreePath: string): string {
    const FALLBACK = "/home/agent/repo.git";
    try {
        const adminDir = execFileSync(
            "git",
            ["-C", worktreePath, "rev-parse", "--absolute-git-dir"],
            { encoding: "utf-8" }
        ).trim();
        // 形如 .../.git/worktrees/<name> 才是 worktree 的 admin 目录
        if (/[\\/]worktrees[\\/][^\\/]+$/.test(adminDir)) {
            const adminName = adminDir.split(/[\\/]/).pop()!;
            return `/home/agent/repo.git/worktrees/${adminName}`;
        }
        return FALLBACK;
    } catch {
        return FALLBACK;
    }
}

/**
 * docker exec <name> sh -c "<command>"
 * 
 * 关键设计：支持 onLine 回调实现流式输出
 * sandcastle 实际代码参考: src/sandboxes/docker.ts (handle.exec)
 */
async function dockerExec(
    containerName: string,
    command: string,
    opts?: ExecOptions,
    containerGitDir: string = "/home/agent/repo.git"
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const args = ["exec"];

        // -i: 交互模式（支持 stdin）
        if (opts?.stdin !== undefined) {
            args.push("-i");
        }

        // -w: 指定工作目录
        if (opts?.cwd) {
            args.push("-w", opts.cwd);
        }

        // 自动设置 GIT_DIR/GIT_WORK_TREE 等：
        // GIT_DIR 指向 worktree admin 目录（HEAD = 任务分支），提交落到正确的分支
        // GIT_COMMON_DIR 指向主 .git，共享 objects/refs
        // GIT_CONFIG_* 隔离全局配置，防止沙箱中的 git 操作污染宿主机的 .git/config
        const gitPrefix = `export GIT_DIR=${containerGitDir} GIT_COMMON_DIR=/home/agent/repo.git GIT_WORK_TREE=/home/agent/workspace GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null && `;
        const wrappedCommand = gitPrefix + command;

        // 支持超时：使用 timeout 命令包装（容器内 coreutils 提供）
        const timeoutSec = opts?.timeout ? Math.ceil(opts.timeout / 1000) : 0;
        if (timeoutSec > 0) {
            args.push(containerName, "timeout", "-s", "KILL", `${timeoutSec}s`, "sh", "-c", wrappedCommand);
        } else {
            args.push(containerName, "sh", "-c", wrappedCommand);
        }

        const proc = spawn("docker", args, {
            stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore", // stdin
                "pipe",  // stdout
                "pipe",  // stderr
            ],
        });

        // 如果提供了 stdin，写入并关闭
        if (opts?.stdin !== undefined && proc.stdin) {
            proc.stdin.write(opts.stdin);
            proc.stdin.end();
        }

        // 收集输出
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        // 关键：流式输出处理
        if (opts?.onLine) {
            // 使用 readline 逐行读取 stdout
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
                stdoutChunks.push(line);
                opts.onLine!(line); // 触发回调
            });
        } else {
            proc.stdout!.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
            });
        }

        proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
        });

        proc.on("close", (code) => {
            resolve({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
            });
        });

        proc.on("error", (err) => {
            reject(new Error(`docker exec failed: ${err.message}`));
        });
    });
}

/**
 * docker rm -f <name>
 * -f: 强制删除（即使容器在运行）
 */
async function dockerRemove(name: string): Promise<void> {
    return new Promise((resolve) => {
        // 使用 spawn 而不是 exec，避免命令注入
        const proc = spawn("docker", ["rm", "-f", name]);
        proc.on("close", () => resolve());
        // 忽略错误（容器可能已经被删除）
    });
}