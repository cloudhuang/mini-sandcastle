import type { AgentProvider, ParsedEvent, PrintCommand } from "../types.js";

/**
 * Claude Code Agent Provider
 * 
 * sandcastle 实际代码参考: src/AgentProvider.ts (claudeCode)
 * 
 * Claude Code 的 CLI 输出是 JSON Lines（JSONL）格式，每行一个 JSON 对象
 */
export const claudeCode = (model: string): AgentProvider => ({
    name: "claude-code",

    /**
     * 构建 print 模式的命令
     * 
     * --print: 非交互式模式
     * --output-format stream-json: 输出 JSON 流
     * --dangerously-skip-permissions: 自动确认所有操作（不需要人工确认）
     * -p -: 从 stdin 读取 prompt
     * 
     * 为什么用 stdin？
     * Linux 有 ARG_MAX 限制（约 128KB），大 prompt 作为参数会失败
     * 参考 GitHub Issue: 涉及 Cursor CLI 的 120KB 限制
     */
    buildPrintCommand({ prompt }): PrintCommand {
        return {
            command: `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${escapeShellArg(model)} -p -`,
            stdin: prompt,
        };
    },

    /**
     * 解析 Claude Code 的 JSON 流输出
     * 
     * Claude Code 输出的 JSON 格式示例：
     * {"type":"text","text":"分析代码中..."}
     * {"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}
     * {"type":"result","result":"任务完成"}
     */
    parseStreamLine(line: string): ParsedEvent[] {
        const events: ParsedEvent[] = [];

        if (!line.startsWith("{")) return events;

        try {
            const obj = JSON.parse(line);

            // 文本输出
            if (obj.type === "text" && typeof obj.text === "string") {
                events.push({ type: "text", text: obj.text });
            }

            // 工具调用（如 Bash、Read、Write）
            if (obj.type === "tool_use" && obj.name) {
                const args = obj.input?.command || JSON.stringify(obj.input);
                events.push({ type: "tool_call", name: obj.name, args });
            }

            // 结果输出
            if (obj.type === "result" && typeof obj.result === "string") {
                events.push({ type: "result", result: obj.result });
            }

            // Session ID（用于恢复会话）
            if (obj.session_id || (obj.type === "system" && obj.session_id)) {
                events.push({ type: "session_id", sessionId: obj.session_id || obj.id });
            }
        } catch {
            // 解析失败的行忽略
        }

        return events;
    },
});

/**
 * Shell 参数转义
 * 防止命令注入
 */
function escapeShellArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}