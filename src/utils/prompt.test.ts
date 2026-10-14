import { test, expect } from "vitest";
import { extractTagBlock } from "./prompt.js";

// 与 .sandcastle/run.ts 中 Planner / PR Reviewer 的提取逻辑一致：
// Agent stdout 混杂其他输出时，只取 <tag> 块内的结构化内容

test("extracts a <review> markdown block", () => {
    const stdout = [
        "Let me analyze this PR...",
        "<review>",
        "## Verdict: COMMENT",
        "",
        "| Criterion | Status |",
        "| --- | --- |",
        "| Tests pass | ✅ met |",
        "",
        "### Findings",
        "1. **[P2]** missing edge case handling",
        "</review>",
        "Done. <promise>COMPLETE</promise>",
    ].join("\n");

    const review = extractTagBlock(stdout, "review");

    expect(review).toBeDefined();
    expect(review).toContain("## Verdict: COMMENT");
    expect(review).toContain("**[P2]**");
    // 标签外的内容不应进入结果
    expect(review).not.toContain("Let me analyze");
    expect(review).not.toContain("promise");
});

test("extracts a <plan> JSON block", () => {
    const stdout = 'thinking...\n<plan>{"issues":[{"number":11,"title":"t","branch":"b"}]}</plan>\ntail';
    const plan = extractTagBlock(stdout, "plan");
    expect(JSON.parse(plan!)).toEqual({
        issues: [{ number: 11, title: "t", branch: "b" }],
    });
});

test("returns undefined when the tag is missing", () => {
    expect(extractTagBlock("no tags here", "review")).toBeUndefined();
    expect(extractTagBlock("<other>x</other>", "review")).toBeUndefined();
});

test("block content is trimmed", () => {
    expect(extractTagBlock("a\n<review>\n  body\n</review>\nb", "review")).toBe("body");
});

test("empty block yields undefined-equivalent empty string", () => {
    // 空 <review></review> 提取后为空串，调用方按 falsy 处理
    expect(extractTagBlock("<review></review>", "review")).toBe("");
});
