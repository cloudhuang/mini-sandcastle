import { test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const README_PATH = resolve(import.meta.dirname, "../README.md");

test("README.md exists", () => {
    expect(existsSync(README_PATH)).toBe(true);
});

test("README.md has project title", () => {
    const content = readFileSync(README_PATH, "utf-8");
    expect(content).toContain("# mini-sandcastle");
});

test("README.md has architecture section", () => {
    const content = readFileSync(README_PATH, "utf-8");
    expect(content).toContain("## Architecture");
});

test("README.md has running instructions", () => {
    const content = readFileSync(README_PATH, "utf-8");
    expect(content).toContain("## Running Tests");
    expect(content).toContain("## Running the Sandbox");
});

test("README.md documents test files", () => {
    const content = readFileSync(README_PATH, "utf-8");
    expect(content).toContain("`src/providers/docker.test.ts`");
    expect(content).toContain("`src/utils/worktree.test.ts`");
    expect(content).toContain("`test/readme.test.ts`");
});

test("README.md documents scripts", () => {
    const content = readFileSync(README_PATH, "utf-8");
    expect(content).toContain("`scripts/test-shutdown.ts`");
});
