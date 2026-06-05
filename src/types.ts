/**
 * 沙箱创建选项
 * sandcastle 实际代码参考: src/SandboxProvider.ts
 */
export interface CreateSandboxOptions {
    /** 宿主机上的 worktree 路径 */
    readonly worktreePath: string;
    /** 主仓库根目录（Docker provider 需要它来挂载 .git） */
    readonly repoDir?: string;
    /** 注入到沙箱的环境变量 */
    readonly env: Record<string, string>;
}

/**
 * 命令执行选项
 * sandcastle 实际代码参考: src/SandboxProvider.ts (ExecOptions)
 */
export interface ExecOptions {
    /** 
     * 逐行回调 - 关键设计！
     * 用于实时流式输出和 idle timeout 检测
     */
    readonly onLine?: (line: string) => void;
    /** 工作目录 */
    readonly cwd?: string;
    /** 通过 stdin 输入内容 */
    readonly stdin?: string;
}

/**
 * 命令执行结果
 */
export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

/**
 * 沙箱句柄 - 沙箱 Provider 的核心产出
 * sandcastle 实际代码参考: src/SandboxProvider.ts (BindMountSandboxHandle)
 */
export interface SandboxHandle {
    /** 沙箱内的工作目录 */
    readonly worktreePath: string;
    /** 执行命令 */
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
    /** 清理沙箱 */
    close(): Promise<void>;
}

/**
 * 沙箱 Provider 接口
 * 这是整个架构的基石 - 任何沙箱都必须实现这个接口
 * sandcastle 实际代码参考: src/SandboxProvider.ts
 */
export interface SandboxProvider {
    readonly name: string;
    create(options: CreateSandboxOptions): Promise<SandboxHandle>;
}

/**
 * Agent 命令
 * sandcastle 实际代码参考: src/AgentProvider.ts (PrintCommand)
 */
export interface PrintCommand {
    /** 命令字符串 */
    readonly command: string;
    /** 通过 stdin 传入的内容 */
    readonly stdin?: string;
}

/**
 * Agent Provider 接口
 * sandcastle 实际代码参考: src/AgentProvider.ts
 */
export interface AgentProvider {
    readonly name: string;
    /**
     * 构建 print 模式的命令
     * 为什么需要 stdin? 因为 Linux 有 128KB 的参数长度限制 (ARG_MAX)
     * 大 prompt 通过 stdin 传入可以避免 E2BIG 错误
     */
    buildPrintCommand(options: { prompt: string }): PrintCommand;
    /**
     * 解析 Agent 输出的每一行
     * 不同 Agent 的 JSON 流格式不同
     */
    parseStreamLine(line: string): ParsedEvent[];
}

/**
 * 解析后的事件
 * sandcastle 实际代码参考: src/AgentProvider.ts (ParsedStreamEvent)
 */
export type ParsedEvent =
    | { type: "text"; text: string }
    | { type: "tool_call"; name: string; args: string }
    | { type: "result"; result: string }
    | { type: "session_id"; sessionId: string };