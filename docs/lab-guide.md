# Lab guide: build and attack KidsWay on your own Windows laptop

Time: about one evening for parts 1-3, one more for parts 4-5.
You need: Windows 10/11, 8 GB RAM (16 GB is more comfortable), 30 GB free disk.

Take the screenshots marked 📸. They go into the README and prove you did it yourself.

---

## Part 0. Run the API on Windows first (10 minutes)

1. Install **Node.js 22 LTS** (version 22.18 or newer) from nodejs.org.
2. Open the project folder in VS Code, open a terminal and run:
   ```powershell
   node -v          # must show v22.18 or newer
   npm test         # 35 tests should pass
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

1. Install **VirtualBox** and download **Ubuntu Server 24.04 LTS** (ISO).
2. Create a VM: 2 CPUs, 2 GB RAM, 20 GB disk.
3. Network:
   - Adapter 1: **NAT** (internet for updates)
   - Adapter 2: **Host-only Adapter** (`VirtualBox Host-Only Ethernet Adapter`, network 192.168.56.0/24)
4. Install Ubuntu, tick **Install OpenSSH server**.
5. Give the host-only adapter a static address. Edit `/etc/netplan/50-cloud-init.yaml` (the second interface is often `enp0s8`):
   ```yaml
   network:
     version: 2
     ethernets:
       enp0s3: { dhcp4: true }
       enp0s8: { addresses: [192.168.56.10/24] }
   ```
   then `sudo netplan apply`.
6. From Windows: `ssh youruser@192.168.56.10` 📸

## Part 2. Docker and the app

On the VM:
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install docker.io docker-compose-v2 git ufw fail2ban nmap
sudo usermod -aG docker $USER && newgrp docker

sudo mkdir -p /opt/kidsway && sudo chown $USER /opt/kidsway
git clone https://github.com/<your-username>/kidsway-secure-platform.git /opt/kidsway
cd /opt/kidsway

# secrets
cp .env.example .env
for k in DATA_KEY PEPPER URL_SIGNING_KEY; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 32)|" .env
done
chmod 600 .env

# TLS certificate for the lab
sh deploy/certs/generate-dev-cert.sh

# folder for the security log (the container runs as uid 1000)
sudo chown 1000:1000 deploy/logs

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```
📸 `docker compose ps`: nginx shows ports 80 and 443, api shows **no** ports.

Create the first admin:
```bash
docker compose -f deploy/docker-compose.yml exec -e ADMIN_PHONE=+60123456789 api node --disable-warning=ExperimentalWarning src/seed.ts
```

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
sudo cp deploy/fail2ban/jail.d/kidsway.conf /etc/fail2ban/jail.d/
sudo systemctl restart fail2ban
sudo fail2ban-client status kidsway
```
📸 `ufw status verbose` and `fail2ban-client status kidsway`.

Check the segmentation:
```bash
docker network inspect kidsway_app | grep -i internal      # "Internal": true
docker compose -f deploy/docker-compose.yml exec api wget -qO- -T 3 https://example.com || echo "no internet from api: OK"
```
📸

## Part 4. Scan and attack from outside

Install **Nmap for Windows** (nmap.org, includes Zenmap), then:
```powershell
nmap -sS -sV -p- 192.168.56.10
nmap --script ssl-enum-ciphers -p 443 192.168.56.10
```
Expected: 22, 80, 443 open; **3000 not visible**; only TLS 1.2 and 1.3 offered. 📸

Trigger fail2ban with repeated bad logins (PowerShell):
```powershell
1..30 | % { curl.exe -k -s -o NUL -w "%{http_code} " -H "content-type: application/json" `
  -d '{\"phone\":\"+60123456789\",\"challengeId\":\"fake\",\"code\":\"000000\"}' https://192.168.56.10/api/auth/otp/verify }
```
You will see `400`, then `429` (nginx and app rate limits), and then the connection stops responding: your Windows host is banned.
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
| Browser warns about the certificate | Expected with a self-signed lab certificate. Use `-k` with curl. |
| You banned yourself from SSH | Use the VirtualBox console window and `sudo fail2ban-client unban --all`. |
| Map is grey, address search says "not available" | The app needs internet for OpenStreetMap. You can still move the pin and type the address. |
| `data cannot be decrypted` after copying the project | `data/kidsway.db` belongs to the keys in `.env.local`. Copy both together, or delete both to start fresh. |
| The phone does not offer "Install app" | Installing needs HTTPS with a certificate the phone trusts. The lab's self-signed certificate is enough to use the app in the browser, not to install it. |
