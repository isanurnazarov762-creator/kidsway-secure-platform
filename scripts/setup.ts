// First-run setup for local use: creates .env.local with random secret keys.
// Run again after an update: keys that are missing are added, existing keys are never changed
// (your data in ./data/kidsway.db stays readable because DATA_KEY stays the same).
// .env.local is in .gitignore: never commit it.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const file = new URL("../.env.local", import.meta.url);
const KEYS = ["DATA_KEY", "PEPPER", "URL_SIGNING_KEY", "VERIFIER_KEY"];
const k = () => randomBytes(32).toString("base64");

if (!existsSync(file)) {
  writeFileSync(file, ["# Created by scripts/setup.ts. Keep it private. Losing DATA_KEY means encrypted data cannot be read.", ...KEYS.map((n) => `${n}=${k()}`), ""].join("\n"), { mode: 0o600 });
  console.log("Created .env.local with new secret keys.");
} else {
  const have = readFileSync(file, "utf8");
  const missing = KEYS.filter((n) => !new RegExp(`^${n}=`, "m").test(have));
  if (missing.length) {
    appendFileSync(file, (have.endsWith("\n") ? "" : "\n") + missing.map((n) => `${n}=${k()}`).join("\n") + "\n");
    console.log("Added to .env.local: " + missing.join(", "));
  }
}
