import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("SDK 使用精确版本并声明安全补丁", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const workspaceConfig = await fs.readFile(path.join(projectRoot, "pnpm-workspace.yaml"), "utf8");
  assert.equal(packageJson.dependencies["weixin-agent-sdk"], "0.5.0");
  assert.match(
    workspaceConfig,
    /^\s*weixin-agent-sdk@0\.5\.0:\s+patches\/weixin-agent-sdk@0\.5\.0\.patch\s*$/mu,
  );
  assert.match(workspaceConfig, /^ignoreScripts:\s+true\s*$/mu);
});

test("补丁删除斜杠命令调用和所有入站触发外发分支", async () => {
  const patchText = await fs.readFile(
    path.join(projectRoot, "patches", "weixin-agent-sdk@0.5.0.patch"),
    "utf8",
  );
  assert.match(patchText, /^-\s*if \(textBody\.startsWith\("\/"\)\)/mu);
  assert.match(patchText, /^-\s*if \(response\.media\)/mu);
  assert.match(patchText, /^-\s*sendWeixinErrorNotice\(/mu);
  assert.match(patchText, /^\+\s*await deps\.agent\.chat\(request\);/mu);
});
