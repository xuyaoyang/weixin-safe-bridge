import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { inspectAllowedFile } from "./file-policy.mjs";
import { exportInboxAttachment, listInboxReceipts } from "./inbox-reader.mjs";
import { sendLocalControlRequest } from "./local-control-client.mjs";
import { PolicyError } from "./policy.mjs";
import { resolveDataRoot } from "./runtime-config.mjs";

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new PolicyError("INVALID_ARGUMENT", "参数必须使用 --name value 格式");
    if (options.has(key)) throw new PolicyError("DUPLICATE_ARGUMENT", `参数重复: ${key}`);
    if (key.startsWith("--confirm-")) {
      options.set(key, true);
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new PolicyError("MISSING_ARGUMENT_VALUE", `参数缺少值: ${key}`);
    options.set(key, value);
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) throw new PolicyError("MISSING_REQUIRED_ARGUMENT", `缺少参数 ${name}`);
  return value;
}

function rejectUnknownOptions(options, allowed) {
  for (const key of options.keys()) {
    if (!allowed.has(key)) throw new PolicyError("UNKNOWN_ARGUMENT", `未知参数: ${key}`);
  }
}

async function stageAndPrepare(dataRoot, options) {
  rejectUnknownOptions(options, new Set(["--file", "--text"]));
  const requestedPath = path.resolve(required(options, "--file"));
  const checked = await inspectAllowedFile({
    filePath: requestedPath,
    fileName: path.basename(requestedPath),
    claimedMime: "application/octet-stream",
    allowedRoots: [path.dirname(requestedPath)],
  });
  const outboxRoot = path.join(dataRoot, "outbox");
  const stageRoot = path.join(outboxRoot, "staged", randomUUID());
  await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(stageRoot, checked.safeOriginalName);
  await fs.writeFile(stagedPath, checked.buffer, { flag: "wx", mode: 0o600 });
  const response = await sendLocalControlRequest(dataRoot, {
    operation: "prepare-file",
    filePath: stagedPath,
    fileName: checked.safeOriginalName,
    text: options.get("--text"),
  });
  return {
    operation: "prepared",
    approvalId: response.approvalId,
    expiresAt: response.expiresAt,
    fileName: response.fileName,
    byteLength: response.byteLength,
    sha256: response.sha256,
    detectedMime: checked.detectedMime,
  };
}

async function commitSend(dataRoot, options) {
  rejectUnknownOptions(options, new Set(["--approval", "--confirm-real-send"]));
  if (process.env.WEIXIN_ENABLE_REAL_SEND !== "1" || options.get("--confirm-real-send") !== true) {
    throw new PolicyError(
      "REAL_SEND_GATE_REQUIRED",
      "真实发送需要 WEIXIN_ENABLE_REAL_SEND=1 和 --confirm-real-send 双门禁",
    );
  }
  const approvalId = required(options, "--approval");
  return sendLocalControlRequest(dataRoot, { operation: "commit-file", approvalId, confirmRealSend: true });
}

async function run() {
  const [, , command, ...values] = process.argv;
  const options = parseOptions(values);
  const dataRoot = resolveDataRoot();
  if (command === "prepare-send") return stageAndPrepare(dataRoot, options);
  if (command === "commit-send") return commitSend(dataRoot, options);
  if (command === "list-inbox") {
    rejectUnknownOptions(options, new Set(["--limit"]));
    const limit = options.has("--limit") ? Number(options.get("--limit")) : 10;
    return { operation: "inbox-list", receipts: await listInboxReceipts(dataRoot, { limit }) };
  }
  if (command === "export-inbox") {
    rejectUnknownOptions(options, new Set(["--receipt", "--destination"]));
    return {
      operation: "inbox-exported",
      ...(await exportInboxAttachment(
        dataRoot,
        required(options, "--receipt"),
        path.resolve(required(options, "--destination")),
      )),
    };
  }
  throw new PolicyError(
    "UNKNOWN_FILE_TRANSFER_COMMAND",
    "用法：file-transfer-cli.mjs <prepare-send|commit-send|list-inbox|export-inbox>",
  );
}

try {
  process.stdout.write(`${JSON.stringify({ ok: true, ...(await run()) })}\n`);
} catch (error) {
  const code = error instanceof PolicyError
    ? error.code
    : error?.code === "EEXIST"
      ? "EXPORT_FILE_EXISTS"
      : error?.code === "ENOENT"
        ? "FILE_OR_LOCAL_BRIDGE_NOT_FOUND"
        : error?.code === "EACCES"
          ? "FILE_ACCESS_DENIED"
          : error?.code === "ECONNREFUSED"
            ? "LOCAL_BRIDGE_UNAVAILABLE"
            : "FILE_TRANSFER_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exitCode = 1;
}
