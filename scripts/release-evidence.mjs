import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    parsed[key] = value;
  }
  return parsed;
}

function asBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function pick(args, name, fallback = "") {
  return args[name] ?? process.env[name.replace(/-/g, "_").toUpperCase()] ?? fallback;
}

function nowIso() {
  return new Date().toISOString();
}

const args = parseArgs(process.argv.slice(2));

const rcTag = pick(args, "rc-tag", process.env.RC_TAG ?? "rc/m6-unknown.0");
const runOpenaiCanary = asBool(pick(args, "run-openai-canary", process.env.RUN_OPENAI_CANARY), false);
const gateMockResult = pick(args, "gate-mock", process.env.GATE_MOCK_RESULT ?? "unknown");
const mirrorCheckResult = pick(args, "mirror", process.env.MIRROR_CHECK_RESULT ?? "unknown");
const rollbackDrillResult = pick(args, "rollback", process.env.ROLLBACK_DRILL_RESULT ?? "unknown");

let openaiCanaryResult = pick(args, "openai-canary", process.env.OPENAI_CANARY_STATUS ?? "");
if (!runOpenaiCanary) {
  openaiCanaryResult = "not_requested";
}
if (runOpenaiCanary && !openaiCanaryResult) {
  openaiCanaryResult = "unknown";
}

const workflowRunId = process.env.GITHUB_RUN_ID ?? "local";
const workflowRunAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
const repository = process.env.GITHUB_REPOSITORY ?? "local/local";
const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const workflowName = process.env.GITHUB_WORKFLOW ?? "local-release";
const refName = process.env.GITHUB_REF_NAME ?? "local";
const commitSha = process.env.GITHUB_SHA ?? "local";
const runUrl = `${serverUrl}/${repository}/actions/runs/${workflowRunId}`;

const requiredChecks = [
  { name: "gate_mock", result: gateMockResult, required: true },
  { name: "mirror_check", result: mirrorCheckResult, required: true },
  { name: "rollback_drill", result: rollbackDrillResult, required: true },
  { name: "openai_canary", result: openaiCanaryResult, required: false }
];

const requiredFailures = requiredChecks.filter((item) => item.required && item.result !== "success" && item.result !== "pass");
const goNoGo = requiredFailures.length === 0 ? "GO" : "NO_GO";

const risks = [];
if (openaiCanaryResult === "failure") {
  risks.push("OpenAI canary failed (non-blocking): verify provider credential/network health before production rollout.");
}
if (openaiCanaryResult === "skipped_no_key") {
  risks.push("OpenAI canary skipped due missing OPENAI_API_KEY.");
}
if (requiredFailures.length > 0) {
  for (const failure of requiredFailures) {
    risks.push(`Required gate failed: ${failure.name}=${failure.result}`);
  }
}

const evidence = {
  schemaVersion: "1.0.0",
  generatedAt: nowIso(),
  release: {
    rcTag,
    decision: goNoGo,
    strategy: {
      deployment: "no_online_deploy",
      strictGate: true,
      providerPolicy: "mock_required_openai_optional"
    }
  },
  source: {
    repository,
    workflow: workflowName,
    workflowRunId,
    workflowRunAttempt,
    workflowRunUrl: runUrl,
    branch: refName,
    commitSha
  },
  checks: requiredChecks,
  risks,
  nextActions:
    goNoGo === "GO"
      ? [
          "Create and push RC tag manually on work/main.",
          "Record artifact URL and run URL in docs/release-m6-rc.md.",
          "Keep main as mirror-only."
        ]
      : [
          "Fix required gate failures before RC tag.",
          "Re-run release-rc workflow and regenerate evidence."
        ]
};

const summaryLines = [
  "# M6 RC Release Summary",
  "",
  `- Decision: **${goNoGo}**`,
  `- RC Tag: \`${rcTag}\``,
  `- Branch: \`${refName}\``,
  `- Commit: \`${commitSha}\``,
  `- Workflow: \`${workflowName}\` ([run](${runUrl}))`,
  "",
  "## Gate Results",
  ...requiredChecks.map(
    (item) => `- ${item.required ? "[required]" : "[optional]"} \`${item.name}\`: \`${item.result}\``
  ),
  "",
  "## Risks",
  ...(risks.length > 0 ? risks.map((risk) => `- ${risk}`) : ["- None"]),
  "",
  "## Next Actions",
  ...evidence.nextActions.map((action) => `- ${action}`),
  ""
];

writeFileSync("release-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
writeFileSync("release-summary.md", `${summaryLines.join("\n")}\n`, "utf-8");

console.log(
  JSON.stringify(
    {
      ok: true,
      rcTag,
      goNoGo,
      runUrl
    },
    null,
    2
  )
);
