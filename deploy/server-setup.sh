#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server, run as root (R6). Safe to run again: Usage: server-setup.sh
# SKIP_SYSTEMD=1 skips systemctl, `ufw enable` and starting Docker (for the check in a container).
set -euo pipefail

if [ $# -ne 0 ]; then
  echo "usage: $0" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
SKIP_SYSTEMD=${SKIP_SYSTEMD:-}

# 1. root's key is what gets copied to deploy; with root's SSH off below, an empty file would lock everyone out
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "/root/.ssh/authorized_keys is empty: add your public key first" >&2
  exit 1
fi

if [ -n "$SKIP_SYSTEMD" ]; then
  # packages must not try to start services in a container
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod +x /usr/sbin/policy-rc.d
  trap 'rm -f /usr/sbin/policy-rc.d' EXIT
fi

# 2. packages (cron, logrotate and python3 are on a Hetzner image; offsite-check.sh needs python3)
apt-get update
apt-get -y upgrade
apt-get -y install ca-certificates curl rsync openssh-server sudo ufw fail2ban unattended-upgrades cron logrotate python3

# 3. Docker Engine and the compose plugin from Docker's own apt repository (not snap)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck source=/dev/null
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if [ -z "$SKIP_SYSTEMD" ]; then
  systemctl enable --now docker
fi

# 4. the deploy user: Docker access, root's key, a sudo password (SSH stays key-only)
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker,sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# merge, so keys added to deploy later survive a second run
keys=$(mktemp)
awk '!seen[$0]++' /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys 2>/dev/null >"$keys" || true
install -m 600 -o deploy -g deploy "$keys" /home/deploy/.ssh/authorized_keys
rm -f "$keys"
if [ "$(passwd -S deploy | awk '{print $2}')" != P ]; then
  pw=$(openssl rand -base64 18)
  echo "deploy:$pw" | chpasswd
  echo "sudo password for deploy (shown once): $pw"
  echo "-> put this in the password manager entry 'BookedUp server' now"
fi

# 5. SSH: keys only, no root. 10- wins over cloud-init's 50-cloud-init.conf (first value read is used)
install -d /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/10-bookedup.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
mkdir -p /run/sshd
sshd -t
if [ -z "$SKIP_SYSTEMD" ]; then
  systemctl reload ssh
fi

# 6. firewall (Docker publishes only 80 and 443, see compose.yml)
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
if [ -z "$SKIP_SYSTEMD" ]; then
  ufw --force enable
fi

# 7. fail2ban on SSH; security updates without automatic reboots (reboots are by hand, docs/deploy.md)
cat >/etc/fail2ban/jail.d/bookedup.local <<'CONF'
[sshd]
enabled = true
CONF
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat >/etc/apt/apt.conf.d/52bookedup-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
CONF
if [ -z "$SKIP_SYSTEMD" ]; then
  systemctl enable --now fail2ban
fi

# 8. places and jobs. The jobs run as deploy (never root), so deploy.sh and cron share one owner of .backup.lock
install -d -o deploy -g deploy /opt/bookedup
install -d -m 700 -o deploy -g deploy /var/backups/bookedup
touch /var/log/bookedup-backup.log
chown deploy:deploy /var/log/bookedup-backup.log
cat >/etc/cron.d/bookedup-backup <<'CRON'
7 * * * * deploy /opt/bookedup/backup.sh >> /var/log/bookedup-backup.log 2>&1
40 4 * * 0 deploy /opt/bookedup/offsite-check.sh >> /var/log/bookedup-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/bookedup-backup
install -d /etc/logrotate.d
cat >/etc/logrotate.d/bookedup-backup <<'CONF'
/var/log/bookedup-backup.log {
  weekly
  rotate 8
  missingok
  notifempty
  compress
  create 0640 deploy deploy
}
CONF

# 9.
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Before closing this session: in another terminal \`ssh deploy@${ip:-<ip>} docker ps\` must work."
