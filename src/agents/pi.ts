import type { AgentProvider, ParsedEvent, PrintCommand } from "../types.js";

/**
 * Pi Agent Provider
 *
 * Pi 是 @earendil-works/pi-coding-agent 提供的 CLI 工具
 * 支持 `--mode json` 输出 JSON Lines 事件流
 *
 * Pi 的 JSON 事件格式文档:
 * https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/json.md
 */
export const piAgent = (model?: string): AgentProvider => ({
    name: "pi",

    /**
     * 构建 print 模式的命令
     *
     * --mode json: 输出 JSON 事件流（JSON Lines）
     * -p: 非交互式模式（process prompt and exit）
     *
     * 注意：pi 不支持从 stdin 读取 prompt，直接通过参数传递
     * Linux ARG_MAX ~128KB，对大 prompt 可考虑写入临时文件用 @file 语法
     */
    buildPrintCommand({ prompt }): PrintCommand {
        const modelFlag = model ? ` --model ${escapeShellArg(model)}` : "";
        return {
            command: `pi --mode json -p ${escapeShellArg(prompt)}${modelFlag}`,
        };
    },

    /**
     * 解析 Pi 的 JSON 流输出
     *
     * Pi 输出的 JSON 格式示例：
     * {"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
     * {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}
     * {"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{"command":"ls -la"}}
     * {"type":"tool_execution_end","toolCallId":"...","toolName":"bash","result":"...","isError":false}
     * {"type":"agent_end","messages":[...]}
     */
    parseStreamLine(line: string): ParsedEvent[] {
        const events: ParsedEvent[] = [];

        if (!line.startsWith("{")) return events;

        try {
            const obj = JSON.parse(line);

            // 会话头 → session_id
            if (obj.type === "session" && typeof obj.id === "string") {
                events.push({ type: "session_id", sessionId: obj.id });
            }

            // message_end: 提取 assistant 完整消息中的文本内容
            // 注意：只处理 role === "assistant" 的消息，避免提取 toolResult 的工具输出
            // 不解析 text_delta，因为 kimi 等模型的 text_delta 为空，只有 message_end 有完整文本
            if (
                obj.type === "message_end" &&
                obj.message?.role === "assistant" &&
                Array.isArray(obj.message?.content)
            ) {
                for (const item of obj.message.content) {
                    if (item.type === "text" && typeof item.text === "string") {
                        events.push({
                            type: "text",
                            text: item.text,
                        });
                    }
                }
            }

            // 工具执行开始
            if (obj.type === "tool_execution_start" && typeof obj.toolName === "string") {
                const args =
                    typeof obj.args === "object" && obj.args !== null
                        ? JSON.stringify(obj.args)
                        : String(obj.args ?? "");
                events.push({
                    type: "tool_call",
                    name: obj.toolName,
                    args,
                });
            }

            // agent_end 可以视为一个结果完成信号（可选）
            if (obj.type === "agent_end") {
                events.push({
                    type: "result",
                    result: "Agent session completed",
                });
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
