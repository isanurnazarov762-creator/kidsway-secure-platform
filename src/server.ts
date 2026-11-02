import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const app = createApp(cfg);

// Local development only: create an admin account so the web app can be tried end to end.
if (cfg.env !== "production" && process.env.DEV_ADMIN_PHONE) {
  try { app.createStaff(process.env.DEV_ADMIN_PHONE, "Dev admin", "admin"); console.log(`Dev admin: log in with ${process.env.DEV_ADMIN_PHONE}`); } catch { /* already exists */ }
}

if (cfg.insecureDemo) {
  console.warn("\n  !!! INSECURE_DEMO=1: some defences are switched OFF so the attack scripts can show the difference. !!!\n  Never run this mode anywhere real.\n");
}

// Regular plans: create the coming week's trips now and every 30 minutes.
const runPlans = () => { try { const n = app.materialize(); if (n) console.log(`Plans: ${n} new trip(s) scheduled`); } catch (e) { console.error("plan scheduler:", (e as Error).message); } };
runPlans();
const planTimer = setInterval(runPlans, 30 * 60 * 1000);
planTimer.unref();

const server = createServer((req, res) => { void app.handle(req, res); });
// Slow-request (Slowloris-style) protection
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

server.listen(cfg.port, cfg.host, () => {
  console.log(`KidsWay API listening on http://${cfg.host}:${cfg.port} (${cfg.env}${cfg.insecureDemo ? ", INSECURE DEMO" : ""})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.close(() => { app.db.close(); process.exit(0); }); });
}
