#!/usr/bin/env bash
# Initial, native installation for the inspected Ubuntu x86_64 Droplet.
# Adds only mlp-social. It does not install packages, restart the other game,
# modify SSH/firewalls/proxy settings, or open a public application port.
set -Eeuo pipefail
trap 'printf "\nSetup stopped at line %s. Send the console output before retrying.\n" "$LINENO" >&2' ERR

[[ $(id -u) == 0 ]] || { echo 'Run this in the root Droplet console.' >&2; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'This installer requires Linux x86_64.' >&2; exit 1; }
for tool in curl git tar xz sha256sum awk ss getent useradd install systemctl systemd-analyze; do
    command -v "$tool" >/dev/null || { printf 'Missing tool: %s. Send this output.\n' "$tool" >&2; exit 1; }
done
[[ -d /run/systemd/system ]] || { echo 'Systemd is required.' >&2; exit 1; }
[[ ! -e /opt/mlp-social && ! -L /opt/mlp-social ]] || { echo '/opt/mlp-social already exists. Stop and send this output.' >&2; exit 1; }
[[ ! -e /etc/systemd/system/mlp-social.service && ! -L /etc/systemd/system/mlp-social.service ]] || { echo 'The baseball service already exists. Stop and send this output.' >&2; exit 1; }
[[ ! -e /var/lib/mlp-social && ! -L /var/lib/mlp-social ]] || { echo 'An account data directory already exists. Stop and send this output.' >&2; exit 1; }
if getent passwd mlp-social >/dev/null || getent group mlp-social >/dev/null; then
    echo 'A mlp-social account/group already exists. Stop and send this output.' >&2; exit 1
fi
[[ -z $(ss -H -lnt 'sport = :18081') ]] || { echo 'TCP port 18081 is occupied. No changes made.' >&2; exit 1; }
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
(( available_kb >= 409600 )) || { echo 'Less than 400 MiB memory is available. Stop and send this output.' >&2; exit 1; }
disk_kb=$(df -Pk /opt | awk 'NR==2 {print $4}')
(( disk_kb >= 512000 )) || { echo 'Less than 500 MiB disk space is available. Stop and send this output.' >&2; exit 1; }

install -d -m 0755 /opt/mlp-social /opt/mlp-social/download /opt/mlp-social/runtime
git clone --depth 1 --branch feature/accounts-friends-parties https://github.com/joshgrof5-sudo/lobby-server.git /opt/mlp-social/app
cd /opt/mlp-social/download
curl --fail --location --retry 2 --connect-timeout 15 --max-time 120 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o SHASUMS256.txt
awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print; count++ } END { if (count != 1) exit 1 }' SHASUMS256.txt > node.sha256
archive=$(awk '{print $2}' node.sha256)
curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 "https://nodejs.org/dist/latest-v24.x/$archive" -o "$archive"
sha256sum --check node.sha256
tar -xJf "$archive" -C /opt/mlp-social/runtime --strip-components=1 --no-same-owner
/opt/mlp-social/runtime/bin/node --version
cd /opt/mlp-social/app
/opt/mlp-social/runtime/bin/node --test server.test.mjs

# Existing software remains untouched; only this service account/unit is added.
useradd --system --user-group --no-create-home --home-dir /var/lib/mlp-social --shell /usr/sbin/nologin mlp-social
install -m 0644 mlp-social.service /etc/systemd/system/mlp-social.service
systemd-analyze verify /etc/systemd/system/mlp-social.service
systemctl daemon-reload
systemctl enable --now mlp-social.service
healthy=0
for attempt in {1..15}; do
    if curl --silent --fail http://127.0.0.1:18081/health -o /opt/mlp-social/download/health.json; then
        if /opt/mlp-social/runtime/bin/node --input-type=module -e "import{readFileSync}from'node:fs';const d=JSON.parse(readFileSync('/opt/mlp-social/download/health.json'));if(d.service!=='mlp-social'||d.version!==1)process.exit(1)"; then
            healthy=1
            break
        fi
    fi
    sleep 1
done
if (( healthy == 0 )); then
    systemctl stop mlp-social.service
    echo 'Baseball failed its health check and was stopped. The other game was not restarted.' >&2
    journalctl -u mlp-social.service -n 25 --no-pager
    exit 1
fi
printf '\nBASEBALL SERVICE READY (private, local only)\n'
cat /opt/mlp-social/download/health.json
printf '\nExisting game UDP listeners:\n'
ss -lnup 'sport = :7777'
printf '\nSend a screenshot of this result. HTTPS setup is the next step.\n'
