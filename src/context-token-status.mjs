import fs from "node:fs/promises";
import path from "node:path";

const CONTEXT_TOKEN_MAX_AGE_MS = 23 * 60 * 60 * 1000;

export function resolveContextTokenStatePath(dataRoot) {
  return path.join(path.resolve(dataRoot), "sdk-state", "openclaw-weixin", "context-tokens.json");
}

export async function readContextTokenStatus(dataRoot, { clock = () => Date.now() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(resolveContextTokenStatePath(dataRoot), "utf8"));
  } catch {
    return Object.freeze({ available: false });
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
    return Object.freeze({ available: false });
  }
  const now = clock();
  const fresh = parsed.records
    .filter((record) => Number.isFinite(record?.receivedAtMs))
    .filter((record) => record.receivedAtMs <= now && now - record.receivedAtMs < CONTEXT_TOKEN_MAX_AGE_MS)
    .sort((left, right) => right.receivedAtMs - left.receivedAtMs);
  if (fresh.length === 0) return Object.freeze({ available: false });
  const receivedAtMs = fresh[0].receivedAtMs;
  return Object.freeze({
    available: true,
    receivedAt: new Date(receivedAtMs).toISOString(),
    expiresAtEstimate: new Date(receivedAtMs + CONTEXT_TOKEN_MAX_AGE_MS).toISOString(),
  });
}
