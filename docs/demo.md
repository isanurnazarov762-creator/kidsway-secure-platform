# Public demo

A public copy of the three apps so classmates, teachers and employers can click through them from a link.
It runs on Render's free plan from [`render.yaml`](../render.yaml) with `NODE_ENV=demo`.

| App | Path | Demo account |
|---|---|---|
| KidsWay (parents) | `/` | any `+60` number, e.g. `+60123456789` |
| KidsWay Guardian | `/guardian/` | `+60111222333` (demo Guardian); applying at `/guardian/apply` |
| KidsWay Control | `/control/` | `+60100000000` (admin), `+60100000001` (second vetting officer) |

## How the demo differs from the lab deployment

| | Lab (`docs/lab-guide.md`) | Public demo |
|---|---|---|
| SMS code | to a server-side outbox only the admin can read | **shown on screen**, labelled, because there is no SMS gateway and only test data |
| Data | SQLite on a Docker volume, kept | **in memory**, lost when the free service sleeps (15 minutes without visitors) or restarts |
| Accounts | admin created with the seed script | demo admin, second officer and Guardian created at start |
| Banner | none | yellow **DEMO** banner on every page: "test data only" |
| Network | nginx, UFW, fail2ban, internal Docker networks | Render's HTTPS proxy in front of the API container; no AI verifier |

Guard rails in code: demo mode refuses a real SMS provider and the insecure attack mode (`test/demo.test.ts`), and production never puts a code in a response.

**Do not enter real names, children's details, MyKad numbers or documents in the demo.** Anyone with the link can sign in as the demo admin and see everything.

The first visit after a pause takes about a minute: the free service is waking up.
