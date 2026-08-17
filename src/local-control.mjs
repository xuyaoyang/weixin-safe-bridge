import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PolicyError } from "./policy.mjs";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

export function resolveLocalControlPaths(dataRoot) {
  const resolvedRoot = path.resolve(dataRoot);
  const suffix = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 16);
  return {
    controlRoot: path.join(resolvedRoot, "local-control"),
    tokenPath: path.join(resolvedRoot, "local-control", "auth-token"),
    pipePath: process.platform === "win32"
      ? `\\\\.\\pipe\\weixin-safe-bridge-${suffix}`
      : path.join(os.tmpdir(), `weixin-safe-bridge-${suffix}.sock`),
  };
}

export async function ensureLocalControlToken(dataRoot) {
  const { controlRoot, tokenPath } = resolveLocalControlPaths(dataRoot);
  await fs.mkdir(controlRoot, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tokenPath, `${randomBytes(32).toString("hex")}\n`, {
      encoding: "ascii",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return readLocalControlToken(dataRoot);
}

export async function readLocalControlToken(dataRoot) {
  const { tokenPath } = resolveLocalControlPaths(dataRoot);
  const token = (await fs.readFile(tokenPath, "ascii")).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new PolicyError("INVALID_LOCAL_CONTROL_TOKEN", "本地控制令牌缺失或格式无效");
  }
  return token;
}

export function localControlTokenMatches(expected, supplied) {
  if (!TOKEN_PATTERN.test(String(supplied ?? ""))) return false;
  const expectedBytes = Buffer.from(expected, "ascii");
  const suppliedBytes = Buffer.from(supplied, "ascii");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
