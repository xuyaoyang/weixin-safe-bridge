import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOutboundController } from "../src/outbound-controller.mjs";

test("出站拒绝越界路径和未准备对象，只发送同控制器显式准备的内容", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-outbound-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sent = [];
  const controller = createOutboundController({
    dataRoot: path.join(root, "data"),
    transport: { async sendMessage(payload) { sent.push(payload); } },
  });
  await fs.mkdir(controller.outboxRoot, { recursive: true });

  const outside = path.join(root, "outside.pdf");
  await fs.writeFile(outside, "%PDF-1.7\n%%EOF\n");
  await assert.rejects(
    controller.prepare({ filePath: outside, fileName: "outside.pdf" }),
    (error) => error.code === "FILE_PATH_OUTSIDE_ALLOWED_ROOT",
  );
  await assert.rejects(
    controller.send({ payload: { text: "伪造" } }),
    (error) => error.code === "UNPREPARED_OUTBOUND",
  );

  const preparedText = await controller.prepare({ text: "本地明确发起的消息" });
  await controller.send(preparedText);
  assert.deepEqual(sent, ["本地明确发起的消息"]);

  const file = path.join(controller.outboxRoot, "report.pdf");
  await fs.writeFile(file, "%PDF-1.7\n%%EOF\n");
  const preparedFile = await controller.prepare({ text: "受控附件", filePath: file, fileName: "report.pdf" });
  await controller.send(preparedFile);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, "受控附件");
  assert.equal(sent[1].media.url, file);
});

test("不同控制器之间不能复用准备对象", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-capability-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transport = { async sendMessage() {} };
  const first = createOutboundController({ dataRoot: path.join(root, "first"), transport });
  const second = createOutboundController({ dataRoot: path.join(root, "second"), transport });
  const prepared = await first.prepare({ text: "受控消息" });
  await assert.rejects(second.send(prepared), (error) => error.code === "UNPREPARED_OUTBOUND");
});

test("受控 outbox 中的 EXE、压缩包和 DWG 原文件均按普通文件发送", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-dwg-outbound-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sent = [];
  const controller = createOutboundController({
    dataRoot: path.join(root, "data"),
    transport: { async sendMessage(payload) { sent.push(payload); } },
  });
  await fs.mkdir(controller.outboxRoot, { recursive: true });
  for (const [name, content] of [
    ["drawing.dwg", "not-inspected"],
    ["bundle.zip", "archive-bytes"],
    ["tool.exe", "MZ-bytes"],
  ]) {
    const file = path.join(controller.outboxRoot, name);
    await fs.writeFile(file, content);
    const prepared = await controller.prepare({ filePath: file, fileName: name });
    await controller.send(prepared);
  }

  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((item) => item.media.type), ["file", "file", "file"]);
  assert.deepEqual(sent.map((item) => item.media.fileName), ["drawing.dwg", "bundle.zip", "tool.exe"]);
});

test("出站文件在准备后被替换时拒绝发送", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-outbound-revalidation-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sent = [];
  const controller = createOutboundController({
    dataRoot: path.join(root, "data"),
    transport: { async sendMessage(payload) { sent.push(payload); } },
  });
  await fs.mkdir(controller.outboxRoot, { recursive: true });
  const file = path.join(controller.outboxRoot, "drawing.dwg");
  await fs.writeFile(file, Buffer.concat([Buffer.from("AC1032", "ascii"), Buffer.alloc(58)]));
  const prepared = await controller.prepare({ filePath: file, fileName: "drawing.dwg" });
  await fs.appendFile(file, "x");

  await assert.rejects(
    controller.send(prepared),
    (error) => error.code === "OUTBOUND_FILE_CHANGED_AFTER_PREPARE",
  );
  assert.equal(sent.length, 0);
});
