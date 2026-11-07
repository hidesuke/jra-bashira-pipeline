#!/usr/bin/env node
// 非公開リポジトリのプロンプト本文を KV に入れる。
// キーは prompt:v2:course / prompt:v2:race。値は {"version","text"}。
//
// node scripts/put-prompts.mjs --stage course --version 3 --file ./course.md --remote
// node scripts/put-prompts.mjs --stage race --version 4 --file ./race.md --namespace-id <id> --remote

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

const stage = flag("--stage");
const version = flag("--version");
const file = flag("--file");
const namespaceId = flag("--namespace-id");
const remote = args.includes("--remote");
const preview = args.includes("--preview");
const local = args.includes("--local");

if (!stage || !["course", "race"].includes(stage) || !version || !file || (!remote && !preview && !local)) {
  console.error(
    "使い方: node scripts/put-prompts.mjs --stage course|race --version <版> --file <本文ファイル> (--remote | --preview | --local) [--namespace-id <id>]",
  );
  process.exit(1);
}

const text = readFileSync(file, "utf8");
if (!text.trim()) {
  console.error("プロンプトファイルが空です");
  process.exit(1);
}

const destination = join(tmpdir(), `jra-prompt-${stage}-${version}.json`);
writeFileSync(destination, JSON.stringify({ version, text }));

const wranglerArgs = ["wrangler", "kv", "key", "put", `prompt:v2:${stage}`, "--path", destination];
if (namespaceId) wranglerArgs.push("--namespace-id", namespaceId);
else wranglerArgs.push("--binding", "APP_KV");
if (remote) wranglerArgs.push("--remote");
if (preview) wranglerArgs.push("--preview");
if (local) wranglerArgs.push("--local");

const result = spawnSync("npx", wranglerArgs, { stdio: "inherit" });
unlinkSync(destination);
process.exit(result.status ?? 1);
