#!/usr/bin/env node
// prompts/v1 を KV の prompt:v2:course / prompt:v2:race に入れる。
// 値は {"version":"v1","system","user"}。--remote を付けたときだけ本番 KV に書く。
//
// node scripts/put-prompts.mjs --dry-run
// node scripts/put-prompts.mjs --local
// node scripts/put-prompts.mjs --namespace-id <id> --remote

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) return undefined;
  return args[index + 1];
}

const namespaceId = flag("--namespace-id");
const remote = args.includes("--remote");
const preview = args.includes("--preview");
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");

if (!remote && !preview && !local && !dryRun) {
  console.error("使い方: node scripts/put-prompts.mjs (--dry-run | --local | --preview | --remote) [--namespace-id <id>]");
  console.error("prompts/v1/course.md と race_system.md と race_user.md を version v1 で入れます。本番へ書くのは --remote のときだけです。");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const course = readFileSync(join(root, "prompts/v1/course.md"), "utf8");
const raceSystem = readFileSync(join(root, "prompts/v1/race_system.md"), "utf8");
const raceUser = readFileSync(join(root, "prompts/v1/race_user.md"), "utf8");
if (!course.trim() || !raceSystem.trim() || !raceUser.trim()) {
  console.error("prompts/v1 のファイルが空です");
  process.exit(1);
}

const payloads = {
  "prompt:v2:course": { version: "v1", system: course, user: "" },
  "prompt:v2:race": { version: "v1", system: raceSystem, user: raceUser },
};

if (dryRun) {
  for (const [key, value] of Object.entries(payloads)) {
    console.log(`${key} version=${value.version} system=${value.system.length} user=${value.user.length}`);
  }
  process.exit(0);
}

const files = [];
for (const [key, value] of Object.entries(payloads)) {
  const destination = join(tmpdir(), `jra-prompt-${key.replaceAll(":", "-")}.json`);
  writeFileSync(destination, JSON.stringify(value));
  files.push(destination);
  const wranglerArgs = ["wrangler", "kv", "key", "put", key, "--path", destination];
  if (namespaceId) wranglerArgs.push("--namespace-id", namespaceId);
  else wranglerArgs.push("--binding", "APP_KV");
  if (remote) wranglerArgs.push("--remote");
  if (preview) wranglerArgs.push("--preview");
  if (local) wranglerArgs.push("--local");
  const result = spawnSync("npx", wranglerArgs, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    for (const file of files) unlinkSync(file);
    process.exit(result.status ?? 1);
  }
}
for (const file of files) unlinkSync(file);
