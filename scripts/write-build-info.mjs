import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fromEnv = (process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || "").trim();
const inCi = process.env.WORKERS_CI === "1" || Boolean(fromEnv);
let sha = fromEnv;
if (!sha && inCi) {
  try {
    sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    sha = "";
  }
}
if (!inCi) {
  process.exit(0);
}

const target = join(dirname(fileURLToPath(import.meta.url)), "../src/build-info.ts");
const body = `// scripts/write-build-info.mjs がビルド時に上書きする。未実行のときは空。\nexport const BUILD_COMMIT = ${JSON.stringify(sha)};\n`;
writeFileSync(target, body);
