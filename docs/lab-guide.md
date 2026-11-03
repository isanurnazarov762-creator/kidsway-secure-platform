# Lab guide: build and attack KidsWay on your own Windows laptop

Time: about one evening for parts 1-3, one more for parts 4-5.
You need: Windows 10/11 with virtualization enabled, 8 GB RAM (16 GB is more comfortable), 30 GB free disk. Everything is free: VirtualBox, Ubuntu, Nmap.

Tested on: Windows 11, VirtualBox 7, Ubuntu Server 26.04.1 LTS. Real results: README, *Lab results*.

Take the screenshots marked 📸. They go into the README and prove you did it yourself.

---

## Part 0. Run the API on Windows first (10 minutes)

1. Install **Node.js 22 LTS** (version 22.18 or newer) from nodejs.org.
2. Open the project folder in VS Code, open a terminal and run:
   ```powershell
   node -v          # must show v22.18 or newer
   npm test         # 64 tests should pass
   npm run attack:handover
   npm run attack:otp
   npm run attack:idor
   npm run attack:photo-url
   ```
   📸 the test summary and each attack output.

No `npm install` is needed: the project has no third-party runtime packages.

Then try the web app:
```powershell
npm run dev
```
Open http://localhost:3000 in three browser tabs (admin `+60100000000`, a parent, an escort the admin adds) and walk through one trip, one round trip and one regular plan. 📸 each role's screen.
Your data is saved in `data/kidsway.db`; the encryption keys are in `.env.local` (created on the first `npm run dev`). Keep both, or delete both to start fresh.

---

## Part 1. Ubuntu server VM

1. Install **VirtualBox** and download **Ubuntu Server LTS** (ISO, 24.04 or 26.04).
2. VirtualBox → **Network** → **Host-only Networks**: one adapter with IPv4 `192.168.56.1`, mask `255.255.255.0`, **DHCP server off** (we set a static address).
3. Create a VM: 2 CPUs, **4 GB RAM** (the AI verifier needs about 1 GB), 30 GB disk.
4. Network:
   - Adapter 1: **NAT** (internet for updates)
   - Adapter 2: **Host-only Adapter** (the one from step 2)
5. Install Ubuntu. On the storage screen, edit the `ubuntu-lv` volume to use the whole disk (the installer uses about half by default). Tick **Install OpenSSH server**.
6. Give the host-only adapter a static address. `ip -br a` shows the interface names (the second one is usually `enp0s8`). Create `/etc/netplan/60-hostonly.yaml` with `sudo nano`:
   ```yaml
   network:
     version: 2
     ethernets:
       enp0s8:
         dhcp4: false
         addresses: [192.168.56.10/24]
   ```
   then `sudo chmod 600 /etc/netplan/60-hostonly.yaml && sudo netplan apply`, and `ip -br a` again.
7. From Windows: `ssh youruser@192.168.56.10`. The first time, SSH shows the server's key fingerprint. Compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` in the VM console before typing `yes`: that is what stops a man-in-the-middle. 📸

## Part 2. Docker and the app

On the VM:
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install docker.io docker-compose-v2 git ufw fail2ban nmap
sudo usermod -aG docker $USER && newgrp docker

git clone https://github.com/<your-username>/kidsway-secure-platform.git ~/kidsway
cd ~/kidsway

# secrets
cp .env.example .env
for k in DATA_KEY PEPPER URL_SIGNING_KEY VERIFIER_KEY; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 32)|" .env
done
chmod 600 .env
grep '^VERIFIER_KEY=' .env > .env.verifier && chmod 600 .env.verifier   # the AI verifier gets only its key

# TLS certificate for the lab
sh deploy/certs/generate-dev-cert.sh
sudo chown root:root deploy/certs/kidsway.key   # nginx starts as root with all capabilities dropped, so root must own the key

# folders for the security log and the lab SMS outbox (the container runs as uid 1000)
sudo chown 1000:1000 deploy/logs deploy/outbox
chmod 700 deploy/outbox

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```
📸 `docker compose ps`: nginx shows ports 80 and 443, api shows **no** ports.

Create the first admin:
```bash
docker compose -f deploy/docker-compose.yml exec -e ADMIN_PHONE=+60123456789 api node --disable-warning=ExperimentalWarning src/seed.ts
# a second vetting officer (new Guardians need two approvals in production)
docker compose -f deploy/docker-compose.yml exec -e ADMIN_PHONE=+60123456780 -e ADMIN_NAME="Officer 2" api node --disable-warning=ExperimentalWarning src/seed.ts
```

Log in. The lab has no real SMS gateway, so the code goes to the **SMS outbox**, a file on the server that only you can read (the browser never sees it):
```bash
tail -f deploy/outbox/sms.log     # leave it open; Ctrl+C to stop
```
Open **KidsWay Control** at `https://192.168.56.10/control/` (the admin cannot sign in through the parent app at `/`), enter the admin phone, and type the 6-digit code that appears in the outbox. Phone numbers there are masked (`+6012***6789`). Remove `SMS_PROVIDER`/`SMS_OUTBOX_FILE` from `docker-compose.yml` when a real SMS provider is configured.

From Windows (PowerShell):
```powershell
curl.exe -k https://192.168.56.10/healthz
curl.exe -I http://192.168.56.10/            # 301 redirect to https
curl.exe -k -s -o NUL -w "%{http_code}\n" https://192.168.56.10/          # 200: the app
curl.exe -k -s -o NUL -w "%{http_code}\n" https://192.168.56.10/.env      # 404: only the app files, /api, /media and /healthz are routed
```
📸

## Part 3. Firewall and intrusion prevention

```bash
sudo ADMIN_NET=192.168.56.0/24 sh deploy/ufw-setup.sh
sudo cp deploy/fail2ban/filter.d/kidsway.conf /etc/fail2ban/filter.d/
# the jail file says /opt/kidsway; write the real path of your clone
sed "s#/opt/kidsway#$HOME/kidsway#" deploy/fail2ban/jail.d/kidsway.conf | sudo tee /etc/fail2ban/jail.d/kidsway.conf
touch deploy/logs/security.log
sudo systemctl restart fail2ban
sudo fail2ban-client status kidsway   # "File list" must show your real security.log
```
📸 `ufw status verbose` and `fail2ban-client status kidsway`.

Check the segmentation:
```bash
docker network inspect kidsway_app | grep -i internal      # "Internal": true
docker network inspect kidsway_ai | grep -i internal       # "Internal": true (api <-> verifier only)
docker compose -f deploy/docker-compose.yml exec nginx wget -qO- -T 3 http://verifier:8000/healthz || echo "nginx cannot reach the verifier: OK"
docker compose -f deploy/docker-compose.yml exec api wget -qO- -T 3 https://example.com || echo "no internet from api: OK"
```
📸

## Part 4. Scan and attack from outside

Install **Nmap for Windows** (with Npcap): `winget install -e --id Insecure.Nmap`, then open a new terminal:
```powershell
nmap -Pn -p 22,80,443,3000,8000 192.168.56.10
nmap -Pn -p- --min-rate 1000 192.168.56.10            # all 65,535 ports, about 2 minutes
nmap -Pn -p 443 --script ssl-enum-ciphers 192.168.56.10
```
Expected: 22, 80, 443 open; **3000 and 8000 filtered**; only TLS 1.2 and 1.3, `least strength: A`. 📸

Trigger fail2ban with a forged session token (PowerShell):
```powershell
1..25 | % { curl.exe -k -s -o NUL --max-time 3 -w "%{http_code} " -H "Authorization: Bearer fakefakefakefakefake$_" https://192.168.56.10/api/settings }
```
You will see `401` about 20 times and then `000`: the connection stops responding because your Windows host is banned. Repeated wrong login codes (`/api/auth/otp/verify`) work too, but nginx's rate limit answers `429` first, so it takes longer.
On the VM:
```bash
sudo fail2ban-client status kidsway        # your IP 192.168.56.1 in "Banned IP list"
sudo tail deploy/logs/security.log
sudo fail2ban-client set kidsway unbanip 192.168.56.1
```
📸 both.

Optional, stronger: run **OWASP ZAP** (free) against `https://192.168.56.10/api/` from Windows and save its HTML report into `docs/evidence/`.

## Part 5. Put it in the portfolio

- Copy your screenshots into `docs/evidence/screenshots/`.
- Fill in the "Lab results" section of the README with what you saw.
- Push to GitHub (see README).
- Optional: record a 3-5 minute video: architecture diagram, `npm test`, one attack against v0 and v1, nmap from Windows, fail2ban ban.

## Troubleshooting

| Problem | Fix |
|---|---|
| `node: bad option` or `.ts` not running | Node is older than 22.18. Install the current Node 22 LTS. |
| VM has no 192.168.56.10 | Check Adapter 2 is "Host-only" and the interface name in netplan (`ip a`). |
| `docker compose` cannot write `security.log` | `sudo chown 1000:1000 deploy/logs` |
| verifier keeps restarting, log says `libGL.so.1` | Old Dockerfile: `git pull`, then `docker compose -f deploy/docker-compose.yml up -d --build` |
| nginx exits with `cannot load certificate key` | `sudo chown root:root deploy/certs/kidsway.key` |
| fail2ban never bans | `sudo fail2ban-client status kidsway`: "File list" must be your real `deploy/logs/security.log` (see Part 3) |
| Windows: `WinError 10013` when the verifier starts | That port is reserved by Windows. The default is 5091; or set another with `$env:VERIFIER_PORT` and `VERIFIER_URL` in `.env.dev`. |
| Browser warns about the certificate | Expected with a self-signed lab certificate. Use `-k` with curl. |
| You banned yourself from SSH | Use the VirtualBox console window and `sudo fail2ban-client unban --all`. |
| Map is grey, address search says "not available" | The app needs internet for OpenStreetMap. You can still move the pin and type the address. |
| `data cannot be decrypted` after copying the project | `data/kidsway.db` belongs to the keys in `.env.local`. Copy both together, or delete both to start fresh. |
| The phone does not offer "Install app" | Installing needs HTTPS with a certificate the phone trusts. The lab's self-signed certificate is enough to use the app in the browser, not to install it. |
