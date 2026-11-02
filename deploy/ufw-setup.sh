#!/bin/sh
# Host firewall for the Ubuntu server (run as root once).
# Default deny inbound; allow HTTPS for everyone, HTTP only to redirect,
# and SSH only from the admin network (the VirtualBox host-only network in the lab).
set -e
ADMIN_NET="${ADMIN_NET:-192.168.56.0/24}"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 443/tcp comment 'KidsWay HTTPS'
ufw allow 80/tcp  comment 'HTTP -> HTTPS redirect'
ufw allow from "$ADMIN_NET" to any port 22 proto tcp comment 'SSH from admin network only'
ufw limit 22/tcp comment 'SSH brute-force throttle'
ufw logging medium
ufw --force enable
ufw status verbose

# Note: Docker publishes ports through its own iptables chain (DOCKER-USER).
# Only nginx publishes ports (80/443) in docker-compose.yml, so the API stays unreachable.
