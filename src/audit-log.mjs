import fs from "node:fs/promises";
import path from "node:path";

export class AuditLog {
  constructor(auditRoot, { clock = () => new Date() } = {}) {
    this.auditRoot = path.resolve(auditRoot);
    this.clock = clock;
  }

  async append(event) {
    await fs.mkdir(this.auditRoot, { recursive: true });
    const timestamp = this.clock().toISOString();
    const day = timestamp.slice(0, 10);
    const record = JSON.stringify({ timestamp, ...event });
    await fs.appendFile(path.join(this.auditRoot, `${day}.jsonl`), `${record}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
