import { chmod } from "node:fs/promises";

const target = process.argv[2];

if (!target) {
  console.error("Usage: bun scripts/make-executable.ts <file>");
  process.exit(1);
}

if (process.platform !== "win32") {
  await chmod(target, 0o755);
}
