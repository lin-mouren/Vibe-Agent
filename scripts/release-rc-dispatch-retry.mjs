import { spawnSync } from "node:child_process";

function readArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[name.toUpperCase()] ?? fallback;
}

const repo = readArg("repo", "lin-mouren/Vibe-Agent");
const ref = readArg("ref", "work/main");
const rcTag = readArg("rc-tag", "");
const runOpenaiCanary = readArg("run-openai-canary", "true");
const attempts = Number(readArg("attempts", "6"));
const sleepSeconds = Number(readArg("sleep-seconds", "30"));

if (!rcTag) {
  console.error("Missing required --rc-tag");
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  for (let i = 1; i <= attempts; i += 1) {
    const ts = new Date().toISOString();
    console.log(`[dispatch] attempt=${i}/${attempts} ts=${ts}`);

    const run = spawnSync(
      "gh",
      [
        "workflow",
        "run",
        "release-rc.yml",
        "--repo",
        repo,
        "--ref",
        ref,
        "-f",
        `rc_tag=${rcTag}`,
        "-f",
        `run_openai_canary=${runOpenaiCanary}`
      ],
      { encoding: "utf-8" }
    );

    if (run.status === 0) {
      console.log("[dispatch] success");
      const list = spawnSync(
        "gh",
        ["run", "list", "--repo", repo, "--workflow", "release-rc.yml", "--limit", "3"],
        { encoding: "utf-8" }
      );
      if (list.stdout) process.stdout.write(list.stdout);
      if (list.stderr) process.stderr.write(list.stderr);
      process.exit(0);
    }

    if (run.stderr) process.stderr.write(run.stderr);
    if (run.stdout) process.stdout.write(run.stdout);
    console.log("[dispatch] failed");

    if (i < attempts) {
      await sleep(sleepSeconds * 1000);
    }
  }

  console.error("[dispatch] exhausted retries");
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
