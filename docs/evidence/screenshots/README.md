# Lab screenshots

Taken while building the lab on 2026-11-02/03 (Windows 11 host, VirtualBox, Ubuntu Server 26.04.1 LTS).
Files 09, 12, 13 and 14 are rendered from the exact terminal text I captured (the text itself is in [`../`](../)); the others are screen captures.

| File | Shows |
|---|---|
| `01-host-only-network.png` | VirtualBox host-only network 192.168.56.1/24, DHCP off |
| `02-vm-hardware.png` | VM: 4 GB RAM, 2 CPUs |
| `03-vm-network-adapters.png` | Adapter 1 NAT (updates), adapter 2 host-only (lab network) |
| `04-disk-layout.png` | LVM volume extended to the whole 28 GB disk |
| `05-static-ip-netplan.png` | Static 192.168.56.10 on enp0s8 with netplan |
| `06-ssh-fingerprint.png` | First SSH login: ED25519 host key fingerprint checked against the VM console |
| `07-docker-installed.png` | Docker and Compose working, repository cloned |
| `08-containers-ufw-fail2ban.png` | After a reboot: all 3 containers up, only nginx publishes ports, UFW active, both jails running |
| `09-network-isolation.png` | Internal networks; nginx cannot reach the verifier; the API has no internet |
| `10-env-file-blocked.png` | `https://192.168.56.10/.env` → 404 |
| `11-fail2ban-setup.png` | UFW rules and the fail2ban jail with the real log path |
| `12-nmap-all-ports.png` | Full TCP scan: only 22, 80, 443 open |
| `13-nmap-tls.png` | TLS 1.2 / 1.3 only, every cipher graded A |
| `14-fail2ban-ban.png` | Forged-token attack → Windows host banned automatically |
