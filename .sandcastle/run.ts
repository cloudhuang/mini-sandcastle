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
import { pruneStaleWorktrees, repairPollutedGitConfig } from "../src/utils/worktree.js";

// 加载 .env（GH_TOKEN 等）——容器内的 agent 需要它访问 GitHub
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
  // Planner 只做只读分析（读 issues、输出 <plan> JSON），不需要分支和 worktree。
  // 用快照沙箱运行：仓库 clone 到临时目录、docker cp 进容器、零宿主机代码挂载
  // （认证缓存仍挂载，但仓库代码目录完全不接触宿主机），
  // 结束后快照整个丢弃，不会留下 sandcastle/plan-N 分支或孤儿 worktree。
  const plan = await run({
    name: "Planner",
    repoDir,
    agent: createAgent(),
    sandbox: docker(),
    prompt: loadPrompt(".sandcastle/plan-prompt.md"),
    snapshot: true,
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

  // 过滤掉已经关闭、本轮已处理、或已有 open PR 的 issue
  // PR 是 issue 生命周期的终点：PR 合并时 GitHub 自动关闭 issue；
  // 已有 open PR 的 issue 正在等人工审查，不重复实现
  const openPRs = getOpenPullRequests();
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
    const existingPR = openPRs.find((p) => p.headRefName === issue.branch);
    if (existingPR) {
      console.log(
        `  ⏭️  #${issue.number} already has open PR #${existingPR.number}, awaiting review — skipping`,
      );
      return false;
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
    console.log("No commits produced. Nothing to publish.");
    continue;
  }

  // Phase 4: Publish — push 分支并创建 PR
  // 不直接动 master：PR 是人类的审查关口，
  // issue 由 GitHub 在 PR 合并时自动关闭（PR body 里的 Closes #N）
  repairPollutedGitConfig(repoDir);

  for (const issue of completedIssues) {
    publishPr(repoDir, issue);
  }

  // Planner 运行在快照沙箱里，不会留下分支/worktree；
  // 这里只需顺手清理可能残留的注册表记录
  pruneStaleWorktrees(repoDir);
}

console.log("\nAll done.");

/**
 * 获取当前 open 的 PR 列表（headRefName → PR）
 * 用于防止重复处理：已有 open PR 的 issue 不再被重新实现
 */
function getOpenPullRequests(): { number: number; headRefName: string }[] {
  try {
    const output = execSync("gh pr list --state open --json number,headRefName", {
      cwd: repoDir,
      encoding: "utf-8",
    });
    return JSON.parse(output.trim()) as { number: number; headRefName: string }[];
  } catch {
    return [];
  }
}

/**
 * push 任务分支到 origin 并创建 PR
 * 这是确定性的宿主机操作（用宿主机凭据，不依赖容器内 token 权限）
 * PR body 带 "Closes #N"，合并时 GitHub 自动关闭 issue
 * PR 创建成功后清理本地分支（远端分支随 PR 保留）
 */
function publishPr(
  repoDir: string,
  issue: { number: number; title: string; branch: string },
): void {
  // 1. push 分支
  try {
    execFileSync("git", ["push", "origin", issue.branch], {
      cwd: repoDir,
      stdio: "pipe",
    });
    console.log(`  📤 Pushed: ${issue.branch}`);
  } catch (err) {
    console.warn(
      `  ⚠️  Push failed for ${issue.branch}, local branch kept: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  // 2. 创建 PR
  const title = `${issue.title} (#${issue.number})`;
  const body = [
    `Automated fix for #${issue.number}: ${issue.title}`,
    "",
    "Produced by mini-sandcastle autonomous run (plan → implement → review).",
    "Human review merges this PR; the issue closes automatically on merge.",
    "",
    `Closes #${issue.number}`,
  ].join("\n");

  try {
    const url = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "master",
        "--head",
        issue.branch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repoDir, encoding: "utf-8" },
    ).trim();
    console.log(`  🔗 PR created: ${url}`);
  } catch (err) {
    console.warn(
      `  ⚠️  PR creation failed for ${issue.branch} (may already exist): ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  // 3. PR 已挂在远端分支上，本地分支可以清理
  try {
    execFileSync("git", ["branch", "-D", issue.branch], {
      cwd: repoDir,
      stdio: "pipe",
    });
    console.log(`  🧹 Deleted local branch: ${issue.branch}`);
  } catch {
    // 忽略
  }
}

