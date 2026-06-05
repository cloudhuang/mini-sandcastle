import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const README_PATH = resolve(import.meta.dirname, "../README.md");

test("README.md does not exist", () => {
    expect(existsSync(README_PATH)).toBe(false);
});
