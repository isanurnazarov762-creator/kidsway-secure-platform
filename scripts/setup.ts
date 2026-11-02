// First-run setup for local use: creates .env.local with random secret keys (once).
// Your data in ./data/kidsway.db stays readable between restarts because the keys stay the same.
// .env.local is in .gitignore: never commit it.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const file = new URL("../.env.local", import.meta.url);
if (existsSync(file)) process.exit(0);
const k = () => randomBytes(32).toString("base64");
writeFileSync(file, [
  "# Created by scripts/setup.ts. Keep it private. Losing DATA_KEY means encrypted data cannot be read.",
  `DATA_KEY=${k()}`,
  `PEPPER=${k()}`,
  `URL_SIGNING_KEY=${k()}`,
  ""
].join("\n"), { mode: 0o600 });
console.log("Created .env.local with new secret keys.");
