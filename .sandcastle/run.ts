import { docker } from "../src/providers/docker.js";
import { claudeCode } from "../src/agents/claude.js";
import { piAgent } from "../src/agents/pi.js";
import type { AgentProvider } from "../src/types.js";
import { run } from "../src/run.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runParallel } from "../src/run-parallel.js";
import { execSync, execFileSync } from "node:child_process";
import { loadDotEnv } from "../src/utils/env.js";
import { removeWorktree, pruneStaleWorktrees, repairPollutedGitConfig } from "../src/utils/worktree.js";

// 加载 .env（GH_TOKEN 等）——merge agent 依赖它关闭 issue / push
loadDotEnv(process.cwd());

const repoDir = process.cwd();
const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 4;

/**
 * 根据环境变量创建 Agent
 * AGENT=pi (默认) | claude
 * MODEL=sonnet | gpt-4o | kimi-for-coding ...
 */
function createAgent(): AgentProvider {
  const agentType = process.env.AGENT ?? "pi";
  const model = process.env.MODEL;

  if (agentType === "claude") {
    return claudeCode(model ?? "claude-sonnet-4");
  }

  // 默认使用 pi
  return piAgent(model);
}

/**
 * 获取已经合并到 master 的分支列表
 */
function getMergedBranches(): string[] {
  try {
    const output = execSync(
      "git branch --merged master --format='%(refname:short)'",
      {
        cwd: repoDir,
        encoding: "utf-8",
      },
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 获取仍在 open 状态的 GitHub issue 列表
 * 优先使用 gh CLI，失败时 fallback 到 curl
 */
function getOpenIssues(): { number: number; title: string }[] {
  try {
    const output = execSync(
      "gh issue list --state open --json number,title",
      {
        cwd: repoDir,
        encoding: "utf-8",
      },
    );
    return JSON.parse(output.trim()) as { number: number; title: string }[];
  } catch {
    // gh 命令失败，尝试用 curl 获取
    try {
      const remoteUrl = execSync("git remote get-url origin", {
        cwd: repoDir,
        encoding: "utf-8",
      }).trim();
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) {
        const [, owner, repo] = match;
        const curlOutput = execSync(
          `curl -s "https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100"`,
          { encoding: "utf-8" }
        );
        const issues = JSON.parse(curlOutput) as Array<{
          number: number;
          title: string;
          pull_request?: unknown;
        }>;
        return issues
          .filter((i) => !i.pull_request)
          .map((i) => ({ number: i.number, title: i.title }));
      }
    } catch {
      // 都失败则返回空
    }
    return [];
  }
}

const mergedBranches = getMergedBranches();
const openIssues = getOpenIssues();
const openIssueNumbers = new Set(openIssues.map((i) => i.number));
const processedIssueNumbers = new Set<number>();

/**
 * 读取 prompt 文件并替换模板变量
 */
function loadPrompt(
  filePath: string,
  vars: Record<string, string> = {},
): string {
  let content = readFileSync(join(repoDir, filePath), "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Phase 1: Plan
  const plan = await run({
    name: "Planner",
    repoDir,
    branch: `sandcastle/plan-${iteration}`,
    agent: createAgent(),
    sandbox: docker(),
    prompt: loadPrompt(".sandcastle/plan-prompt.md"),
  });

  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    console.error("\n❌ DEBUG: plan.stdout:");
    console.error(plan.stdout);
    console.error("❌ DEBUG: plan.stdout length:", plan.stdout.length);
    throw new Error(
      "Planner did not produce a <plan> tag.\n\n" + plan.stdout.slice(0, 2000),
    );
  }

  let { issues } = JSON.parse(planMatch[1]) as {
    issues: { number: number; title: string; branch: string }[];
  };

  // 过滤掉已经关闭或本轮已处理的 issue
  // 关键改进：不再只看分支是否合并，而是看 GitHub issue 是否仍 open
  issues = issues.filter((issue) => {
    if (!openIssueNumbers.has(issue.number)) {
      console.log(`  ⏭️  #${issue.number} already closed on GitHub, skipping`);
      return false;
    }
    if (processedIssueNumbers.has(issue.number)) {
      console.log(
        `  ⏭️  #${issue.number} already processed in this run, skipping`,
      );
      return false;
    }
    if (mergedBranches.includes(issue.branch)) {
      console.log(
        `  ⚠️  #${issue.number} branch was merged but issue still open — will re-process`,
      );
      // 分支已合并但 issue 仍 open，说明之前 merge 可能覆盖了修改
      // 继续处理，让 Agent 重新修复
    }
    return true;
  });

  if (issues.length === 0) {
    console.log("No issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  #${issue.number}: ${issue.title} → ${issue.branch}`);
  }

  // Phase 2: Execute + Review
  const tasks = issues.map((issue) => ({
    id: String(issue.number),
    title: issue.title,
    branch: issue.branch,
    prompt: loadPrompt(".sandcastle/implement-prompt.md", {
      TASK_ID: String(issue.number),
      ISSUE_TITLE: issue.title,
      BRANCH: issue.branch,
    }),
  }));

  const settled = await runParallel(
    tasks,
    createAgent(),
    docker(),
    repoDir,
    MAX_PARALLEL,
  );

  // Phase 3: Review completed tasks
  const completedIssues: typeof issues = [];
  for (let i = 0; i < issues.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled" && outcome.value.success) {
      const result = outcome.value.result;
      if (result.commits.length > 0) {
        completedIssues.push(issues[i]);

        // Review
        await run({
          name: `Reviewer #${issues[i].number}`,
          repoDir,
          branch: issues[i].branch,
          agent: createAgent(),
          sandbox: docker(),
          prompt: loadPrompt(".sandcastle/review-prompt.md", {
            ISSUE_NUMBER: String(issues[i].number),
            ISSUE_TITLE: issues[i].title,
            BRANCH: issues[i].branch,
          }),
        });
      }
    } else {
      console.error(
        `  ✗ #${issues[i].number} (${issues[i].branch}) failed`,
      );
    }
  }

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // Phase 3: Merge
  await run({
    name: "Merger",
    repoDir,
    branch: "sandcastle/merge",
    agent: createAgent(),
    sandbox: docker(),
    prompt: loadPrompt(".sandcastle/merge-prompt.md", {
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      ISSUES: completedIssues
        .map((i) => `- #${i.number}: ${i.title}`)
        .join("\n"),
    }),
  });

  console.log("\nBranches merged.");

  // Phase 4: Integrate — 把 merge 结果整合回 master 并清理已消费的分支
  // merge agent 只在沙箱分支 sandcastle/merge 上工作；
  // master 的整合是确定性的宿主机操作，无需 agent 参与
  const integrated = integrateIntoMaster(repoDir);

  if (integrated) {
    // 整合成功后，本轮消费过的分支都可以安全删除
    cleanupConsumedBranches(repoDir, [
      "sandcastle/merge",
      `sandcastle/plan-${iteration}`,
      ...completedIssues.map((i) => i.branch),
    ]);
  }
}

console.log("\nAll done.");

/**
 * 把 sandcastle/merge 快进合并进 master
 * 快进失败（master 有并发提交）时退化为普通 merge；
 * 任何失败都保留分支，留给人工处理
 */
function integrateIntoMaster(repoDir: string): boolean {
  // 整合前先修复可能被容器内 Agent 污染的 .git/config，
  // 否则宿主机 git 命令全部失效（core.worktree 指向容器路径）
  repairPollutedGitConfig(repoDir);

  try {
    // sandcastle/merge 上没有新提交就无需整合
    const ahead = execFileSync(
      "git",
      ["rev-list", "--count", "master..sandcastle/merge"],
      { cwd: repoDir, encoding: "utf-8" }
    ).trim();
    if (ahead === "0") {
      console.log("\nmaster is already up to date, nothing to integrate.");
      return true;
    }

    execFileSync("git", ["merge", "--ff-only", "sandcastle/merge"], {
      cwd: repoDir,
    });
    console.log(`\nmaster updated to sandcastle/merge.`);
    return true;
  } catch {
    // 快进失败：master 在本轮期间有新提交，做一次普通合并
    try {
      execFileSync("git", ["merge", "--no-edit", "sandcastle/merge"], {
        cwd: repoDir,
      });
      console.log("\nmaster merged with sandcastle/merge.");
      return true;
    } catch {
      console.warn(
        "\n⚠️  Failed to integrate sandcastle/merge into master — branch preserved for manual review."
      );
      return false;
    }
  }
}

/**
 * 删除本轮已消费的分支及其残留 worktree
 * 用 -d（只删除已合并分支）兜底，避免误删未合并的工作
 */
function cleanupConsumedBranches(repoDir: string, branches: string[]): void {
  for (const branch of branches) {
    // 先清残留 worktree 目录（Ctrl+C 中断等情况可能留下）
    const worktreePath = join(
      repoDir,
      ".sandcastle",
      "worktrees",
      branch
    );
    removeWorktree({ path: worktreePath, branch, repoDir });

    try {
      execFileSync("git", ["branch", "-d", branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
      console.log(`  🧹 Deleted branch: ${branch}`);
    } catch {
      // -d 对未合并分支会失败 —— 这是故意的保护，保留分支
      console.warn(`  ⚠️  Branch not fully merged, kept: ${branch}`);
    }
  }
  pruneStaleWorktrees(repoDir);
}
