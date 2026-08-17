import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectOpaqueFile } from "../src/file-policy.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-opaque-file-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("EXE、压缩包和扩展名不匹配文件均作为不透明普通文件接受", async (t) => {
  const root = await fixture(t);
  const cases = [
    ["tool.exe", Buffer.from("MZ-not-executed", "ascii"), "application/x-msdownload"],
    ["bundle.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]), "application/zip"],
    ["opaque.dwg", Buffer.from("not-cad-content", "utf8"), "application/octet-stream"],
    ["archive.7z", Buffer.from("7z-data", "utf8"), "application/x-7z-compressed"],
  ];

  for (const [fileName, content, mimeType] of cases) {
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, content);
    const inspected = await inspectOpaqueFile({
      filePath,
      fileName,
      claimedMime: mimeType,
      allowedRoots: [root],
    });
    assert.equal(inspected.safeOriginalName, fileName);
    assert.equal(inspected.byteLength, content.length);
    assert.equal(inspected.mimeType, mimeType);
    assert.equal(inspected.transportMode, "opaque");
  }
});

test("程序不再对普通文件应用 25 MiB 默认上限", async (t) => {
  const root = await fixture(t);
  const filePath = path.join(root, "large.bin");
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.truncate(26 * 1024 * 1024);
  } finally {
    await handle.close();
  }

  const inspected = await inspectOpaqueFile({
    filePath,
    fileName: "large.bin",
    claimedMime: "application/octet-stream",
    allowedRoots: [root],
  });
  assert.equal(inspected.byteLength, 26 * 1024 * 1024);
});

test("目录、越界路径和可选调用方大小上限仍被拒绝", async (t) => {
  const root = await fixture(t);
  const allowed = path.join(root, "allowed");
  await fs.mkdir(allowed);
  const outside = path.join(root, "outside.bin");
  await fs.writeFile(outside, "x");

  await assert.rejects(
    inspectOpaqueFile({ filePath: outside, allowedRoots: [allowed] }),
    (error) => error.code === "FILE_PATH_OUTSIDE_ALLOWED_ROOT",
  );
  await assert.rejects(
    inspectOpaqueFile({ filePath: allowed, allowedRoots: [allowed] }),
    (error) => error.code === "NOT_A_REGULAR_FILE",
  );

  const limited = path.join(allowed, "limited.bin");
  await fs.writeFile(limited, "12");
  await assert.rejects(
    inspectOpaqueFile({ filePath: limited, allowedRoots: [allowed], maxBytes: 1 }),
    (error) => error.code === "FILE_SIZE_REJECTED",
  );
});
