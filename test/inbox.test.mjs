import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInboxOnlyAgent } from "../src/bridge-agent.mjs";
import { InboxStore } from "../src/inbox-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-safe-bridge-test-"));
  const dataRoot = path.join(root, "data");
  const sourceRoot = path.join(root, "sdk-inbound");
  await fs.mkdir(sourceRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new InboxStore({
    dataRoot,
    allowedAttachmentRoots: [sourceRoot],
    clock: () => new Date("2026-08-16T04:00:00.000Z"),
    randomId: () => "00000000-0000-4000-8000-000000000001",
  });
  return { root, dataRoot, sourceRoot, store };
}

test("命令样式入站文本失败关闭且不保存正文", async (t) => {
  const { dataRoot, store } = await fixture(t);
  const result = await store.ingest({ conversationId: "user@example", text: "/echo whoami" });

  assert.deepEqual(result, { status: "rejected", reason: "COMMAND_STYLE_TEXT" });
  await assert.rejects(fs.stat(path.join(dataRoot, "inbox")), { code: "ENOENT" });
  const audit = await fs.readFile(path.join(dataRoot, "audit", "2026-08-16.jsonl"), "utf8");
  assert.match(audit, /"reason":"COMMAND_STYLE_TEXT"/u);
  assert.doesNotMatch(audit, /whoami/u);
  assert.doesNotMatch(audit, /user@example/u);
});

test("普通文本落入独立消息目录并最小化来源元数据", async (t) => {
  const { store } = await fixture(t);
  const result = await store.ingest({ conversationId: "user@example", text: "这是一条普通记录。" });

  assert.equal(result.status, "accepted");
  assert.equal(await fs.readFile(path.join(result.directory, "message.txt"), "utf8"), "这是一条普通记录。");
  const metadataText = await fs.readFile(path.join(result.directory, "metadata.json"), "utf8");
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.status, "accepted");
  assert.match(metadata.sourceRef, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(metadataText, /user@example/u);
});

test("允许目录内的 PDF 通过内容和 MIME 联合校验后复制", async (t) => {
  const { sourceRoot, store } = await fixture(t);
  const sourceFile = path.join(sourceRoot, "incoming.pdf");
  const content = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
  await fs.writeFile(sourceFile, content);

  const result = await store.ingest({
    conversationId: "source-1",
    text: "附件说明",
    media: {
      type: "file",
      filePath: sourceFile,
      fileName: "..\\项目报告.pdf",
      mimeType: "application/pdf",
    },
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(await fs.readFile(path.join(result.directory, "attachment.pdf")), content);
  assert.equal(result.metadata.media.detectedMime, "application/pdf");
  assert.equal(result.metadata.media.safeOriginalName, "项目报告.pdf");
  assert.doesNotMatch(JSON.stringify(result.metadata), /sdk-inbound/u);
});

test("越界附件和脚本附件都失败关闭", async (t) => {
  const { root, sourceRoot, store } = await fixture(t);
  const outside = path.join(root, "outside.pdf");
  await fs.writeFile(outside, "%PDF-1.7\n%%EOF\n");
  const outsideResult = await store.ingest({
    conversationId: "source-2",
    text: "普通文字",
    media: { type: "file", filePath: outside, fileName: "outside.pdf", mimeType: "application/pdf" },
  });
  assert.equal(outsideResult.status, "rejected");
  assert.equal(outsideResult.reason, "FILE_PATH_OUTSIDE_ALLOWED_ROOT");

  const script = path.join(sourceRoot, "run.ps1");
  await fs.writeFile(script, "Get-ChildItem\n", "utf8");
  const scriptResult = await store.ingest({
    conversationId: "source-2",
    text: "普通文字",
    media: { type: "file", filePath: script, fileName: "run.ps1", mimeType: "text/plain" },
  });
  assert.equal(scriptResult.status, "rejected");
  assert.equal(scriptResult.reason, "BLOCKED_FILE_EXTENSION");
});

test("通用 ZIP 容器不会因文件名伪装为 Office 文档而通过", async (t) => {
  const { sourceRoot, store } = await fixture(t);
  const disguised = path.join(sourceRoot, "fake.docx");
  await fs.writeFile(disguised, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
  const result = await store.ingest({
    conversationId: "source-4",
    text: "普通文字",
    media: {
      type: "file",
      filePath: disguised,
      fileName: "fake.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "UNSUPPORTED_ZIP_CONTAINER");
});

test("Agent 对接受或拒绝的入站消息都返回空对象", async (t) => {
  const { store } = await fixture(t);
  const agent = createInboxOnlyAgent(store);
  assert.deepEqual(await agent.chat({ conversationId: "source-3", text: "普通文本" }), {});
  assert.deepEqual(await agent.chat({ conversationId: "source-3", text: "powershell Get-ChildItem" }), {});
});
