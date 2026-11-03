#!/usr/bin/env bash
# Adds a dedicated HTTPS proxy to the already inspected Droplet.
# Does not restart either game or change the existing game's UDP rules.
set -Eeuo pipefail
trap 'printf "\nHTTPS setup stopped at line %s. Send the output before retrying.\n" "$LINENO" >&2' ERR
hostname=mlp-174-138-88-57.sslip.io
proxy_dir=/opt/mlp-social/https
node=/opt/mlp-social/runtime/bin/node
[[ $(id -u) == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Run in the root console of the Ubuntu x86_64 Droplet.' >&2; exit 1; }
for tool in curl tar sha512sum ss getent awk grep install useradd systemctl systemd-analyze; do
    command -v "$tool" >/dev/null || { printf 'Missing tool: %s. Send this output.\n' "$tool" >&2; exit 1; }
done
[[ -x $node ]] || { echo 'Install the baseball service first.' >&2; exit 1; }
[[ ! -e $proxy_dir && ! -L $proxy_dir ]] || { echo 'The HTTPS directory already exists. Stop and send this output.' >&2; exit 1; }
[[ ! -e /etc/systemd/system/mlp-social-https.service && ! -L /etc/systemd/system/mlp-social-https.service ]] || { echo 'The HTTPS service already exists. Stop and send this output.' >&2; exit 1; }
[[ ! -e /var/lib/mlp-social-https && ! -L /var/lib/mlp-social-https ]] || { echo 'HTTPS state already exists. Stop and send this output.' >&2; exit 1; }
if getent passwd mlp-https >/dev/null || getent group mlp-https >/dev/null; then
    echo 'The HTTPS service account already exists. Stop and send this output.' >&2; exit 1
fi
for port in 80 443; do
    [[ -z $(ss -H -lnt "sport = :$port") ]] || { printf 'TCP port %s is occupied. No changes made.\n' "$port" >&2; exit 1; }
done
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
(( available_kb >= 204800 )) || { echo 'Less than 200 MiB memory available. Stop and send this output.' >&2; exit 1; }
getent ahostsv4 "$hostname" | awk '{print $1}' | grep -qx '174.138.88.57' || { echo 'The free hostname does not resolve to this server. No changes made.' >&2; exit 1; }
"$node" --input-type=module -e "const r=await fetch('http://127.0.0.1:18081/health');const d=await r.json();if(!r.ok||d.service!=='mlp-social'||d.version!==1)process.exit(1)"

install -d -m 0755 "$proxy_dir"
cd "$proxy_dir"
# Official Caddy 2.11.7 release. Pinned SHA-512 from its release manifest.
curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz -o caddy.tar.gz
printf '%s  %s\n' a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7 caddy.tar.gz | sha512sum --check
tar -xzf caddy.tar.gz --no-same-owner caddy
chmod 0755 caddy
./caddy version

cat > Caddyfile <<'CADDY'
{
    admin off
    servers {
        protocols h1 h2
    }
}

mlp-174-138-88-57.sslip.io {
    request_body {
        max_size 8KB
    }
    reverse_proxy 127.0.0.1:18081 {
        header_up X-Forwarded-For {remote_host}
        transport http {
            response_header_timeout 70s
        }
    }
}
CADDY
XDG_DATA_HOME="$proxy_dir/validation" ./caddy validate --config "$proxy_dir/Caddyfile" --adapter caddyfile

useradd --system --user-group --no-create-home --home-dir /var/lib/mlp-social-https --shell /usr/sbin/nologin mlp-https
cat > /etc/systemd/system/mlp-social-https.service <<'UNIT'
[Unit]
Description=Major League Physics HTTPS proxy
After=network-online.target mlp-social.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=mlp-https
Group=mlp-https
ExecStart=/opt/mlp-social/https/caddy run --config /opt/mlp-social/https/Caddyfile --adapter caddyfile
Environment=HOME=/var/lib/mlp-social-https
Environment=XDG_DATA_HOME=/var/lib/mlp-social-https/data
Environment=XDG_CONFIG_HOME=/var/lib/mlp-social-https/config
Environment=GOMEMLIMIT=96MiB
Environment=GOMAXPROCS=1
StateDirectory=mlp-social-https
StateDirectoryMode=0700
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
MemoryHigh=128M
MemoryMax=160M
MemorySwapMax=32M
CPUQuota=20%
CPUWeight=10
Nice=10
TasksMax=64
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT
systemd-analyze verify /etc/systemd/system/mlp-social-https.service
# Add only the two intended web rules if UFW is already active.
# Never enable/reset UFW or alter SSH/game rules.
if command -v ufw >/dev/null; then
    firewall_status=$(LC_ALL=C ufw status)
    printf '%s\n' "$firewall_status"
    if [[ $firewall_status == *'Status: active'* ]]; then
        ufw allow 80/tcp comment 'MLP certificate validation'
        ufw allow 443/tcp comment 'MLP HTTPS'
    fi
fi
systemctl daemon-reload
systemctl enable --now mlp-social-https.service
printf '\nWaiting for a trusted HTTPS certificate (this can take a few minutes)...\n'
healthy=0
for attempt in {1..40}; do
    if curl --silent --fail --connect-timeout 2 --max-time 3 --resolve "$hostname:443:127.0.0.1" "https://$hostname/health" -o health.json; then
        if "$node" --input-type=module -e "import{readFileSync}from'node:fs';const d=JSON.parse(readFileSync('health.json'));if(d.service!=='mlp-social'||d.version!==1)process.exit(1)"; then
            healthy=1
            break
        fi
    fi
    sleep 2
done
if (( healthy == 0 )); then
    printf '\nHTTPS is not verified yet. Do not rerun the installer.\n'
    printf 'A DigitalOcean cloud firewall may need inbound TCP 80 and 443.\n'
    journalctl -u mlp-social-https.service -n 25 --no-pager
    exit 1
fi
printf '\nBASEBALL HTTPS READY\nhttps://%s\n' "$hostname"
cat health.json
printf '\nExisting game UDP listeners:\n'
ss -lnup 'sport = :7777'
printf '\nSend a screenshot. The game URL still needs to be switched after an external check.\n'
