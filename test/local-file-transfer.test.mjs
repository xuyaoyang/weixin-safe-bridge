import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InboxStore } from "../src/inbox-store.mjs";
import { exportInboxAttachment, listInboxReceipts } from "../src/inbox-reader.mjs";
import { sendLocalControlRequest } from "../src/local-control-client.mjs";
import { createLocalOutboundServer } from "../src/local-outbound-server.mjs";
import { createOutboundController } from "../src/outbound-controller.mjs";

const fileTransferCli = path.resolve("src/file-transfer-cli.mjs");

test("本地出站采用短时单次批准，准备阶段不会发送", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-local-send-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const sent = [];
  const controller = createOutboundController({
    dataRoot,
    transport: { async sendMessage(payload) { sent.push(payload); } },
  });
  await fs.mkdir(controller.outboxRoot, { recursive: true });
  const filePath = path.join(controller.outboxRoot, "drawing.dwg");
  await fs.writeFile(filePath, Buffer.concat([Buffer.from("AC1032", "ascii"), Buffer.alloc(58)]));
  const server = await createLocalOutboundServer({
    dataRoot,
    prepareOutbound: controller.prepare,
    sendOutbound: controller.send,
    clock: () => Date.parse("2026-08-17T08:00:00.000Z"),
    randomId: () => "00000000-0000-4000-8000-000000000010",
  });
  t.after(() => server.close());

  const prepared = await sendLocalControlRequest(dataRoot, {
    operation: "prepare-file",
    filePath,
    fileName: "drawing.dwg",
  });
  assert.equal(prepared.operation, "prepared");
  assert.equal(prepared.fileName, "drawing.dwg");
  assert.equal(prepared.sha256, undefined);
  assert.equal(sent.length, 0);

  await assert.rejects(
    sendLocalControlRequest(dataRoot, {
      operation: "commit-file",
      approvalId: prepared.approvalId,
    }),
    (error) => error.code === "REAL_SEND_CONFIRMATION_REQUIRED",
  );
  assert.equal(sent.length, 0);

  const committed = await sendLocalControlRequest(dataRoot, {
    operation: "commit-file",
    approvalId: prepared.approvalId,
    confirmRealSend: true,
  });
  assert.equal(committed.operation, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].media.type, "file");
  await assert.rejects(
    sendLocalControlRequest(dataRoot, {
      operation: "commit-file",
      approvalId: prepared.approvalId,
      confirmRealSend: true,
    }),
    (error) => error.code === "INVALID_OR_EXPIRED_APPROVAL",
  );
});

test("本地状态接口需要认证且不触发发送", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-status-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  let sent = 0;
  const server = await createLocalOutboundServer({
    dataRoot,
    prepareOutbound: async () => { throw new Error("状态检查不应准备发送"); },
    sendOutbound: async () => { sent += 1; },
    outboundStatus: async () => ({
      available: true,
      receivedAt: "2026-08-20T00:00:00.000Z",
      expiresAtEstimate: "2026-08-20T23:00:00.000Z",
    }),
  });
  t.after(() => server.close());

  const status = await sendLocalControlRequest(dataRoot, { operation: "status" });
  assert.deepEqual(status, {
    ok: true,
    operation: "status",
    available: true,
    receivedAt: "2026-08-20T00:00:00.000Z",
    expiresAtEstimate: "2026-08-20T23:00:00.000Z",
  });
  assert.equal(sent, 0);
});

test("收件查询只返回最小元数据，并按精确引用无覆盖导出", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-inbox-export-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const sourceRoot = path.join(root, "sdk-inbound");
  const destination = path.join(root, "export");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  const content = Buffer.concat([Buffer.from("AC1032", "ascii"), Buffer.alloc(58)]);
  const sourcePath = path.join(sourceRoot, "drawing.dwg");
  await fs.writeFile(sourcePath, content);
  const store = new InboxStore({
    dataRoot,
    allowedAttachmentRoots: [sourceRoot],
    clock: () => new Date("2026-08-17T08:00:00.000Z"),
    randomId: () => "00000000-0000-4000-8000-000000000020",
  });
  const ingested = await store.ingest({
    conversationId: "source@example",
    media: {
      type: "file",
      filePath: sourcePath,
      fileName: "drawing.dwg",
      mimeType: "application/octet-stream",
    },
  });
  assert.equal(ingested.status, "accepted");

  const receipts = await listInboxReceipts(dataRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].media.fileName, "drawing.dwg");
  assert.equal(receipts[0].media.sha256, undefined);
  assert.equal(receipts[0].media.transportMode, "opaque");
  assert.doesNotMatch(JSON.stringify(receipts), /source@example|sdk-inbound/u);

  const exported = await exportInboxAttachment(dataRoot, receipts[0].receiptRef, destination);
  assert.deepEqual(await fs.readFile(exported.destinationPath), content);
  await assert.rejects(exportInboxAttachment(dataRoot, receipts[0].receiptRef, destination), { code: "EEXIST" });
});

test("真实发送 CLI 缺少环境门禁时在连接本地桥接前拒绝", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-cli-gate-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [fileTransferCli, "commit-send", "--approval", "00000000-0000-4000-8000-000000000030", "--confirm-real-send"],
    {
      encoding: "utf8",
      env: { ...process.env, WEIXIN_BRIDGE_DATA_DIR: path.join(root, "data"), WEIXIN_ENABLE_REAL_SEND: "0" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "REAL_SEND_GATE_REQUIRED");
});
