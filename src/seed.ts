// Creates the first admin account. Usage:
//   ADMIN_PHONE=+60123456789 ADMIN_NAME="Ops admin" npm run seed
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { PHONE_RE } from "./validate.ts";

const phone = process.env.ADMIN_PHONE || "";
if (!PHONE_RE.test(phone)) {
  console.error("Set ADMIN_PHONE to a Malaysian number in +60 format, for example +60123456789");
  process.exit(1);
}
const app = createApp(loadConfig());
try {
  const id = app.createStaff(phone, process.env.ADMIN_NAME || "Admin", "admin");
  console.log("Admin created:", id, "- log in with this phone number and the SMS code.");
} catch (e) {
  console.error("Could not create admin (does this phone already have an account?)", (e as Error).message);
  process.exit(1);
}
