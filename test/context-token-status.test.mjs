import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readContextTokenStatus,
  resolveContextTokenStatePath,
} from "../src/context-token-status.mjs";

test("会话令牌状态只暴露可用性和时间，不暴露令牌或账号", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-context-status-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tokenPath = resolveContextTokenStatePath(root);
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify({
    version: 1,
    records: [{
      accountId: "private-account",
      userId: "private-user",
      token: "private-context-token",
      receivedAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
    }],
  }));

  const status = await readContextTokenStatus(root, {
    clock: () => Date.parse("2026-08-20T01:00:00.000Z"),
  });
  assert.deepEqual(status, {
    available: true,
    receivedAt: "2026-08-20T00:00:00.000Z",
    expiresAtEstimate: "2026-08-20T23:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(status), /private/u);
});

test("缺失、损坏、未来时间或超过 23 小时的令牌均报告不可用", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-context-expiry-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tokenPath = resolveContextTokenStatePath(root);
  const clock = () => Date.parse("2026-08-20T23:00:00.000Z");

  assert.deepEqual(await readContextTokenStatus(root, { clock }), { available: false });
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, "not-json");
  assert.deepEqual(await readContextTokenStatus(root, { clock }), { available: false });

  for (const receivedAtMs of [
    Date.parse("2026-08-20T00:00:00.000Z"),
    Date.parse("2026-08-21T00:00:00.000Z"),
  ]) {
    await fs.writeFile(tokenPath, JSON.stringify({ version: 1, records: [{ receivedAtMs }] }));
    assert.deepEqual(await readContextTokenStatus(root, { clock }), { available: false });
  }
});
