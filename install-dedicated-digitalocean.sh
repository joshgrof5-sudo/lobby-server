#!/usr/bin/env bash
# Adds a single dedicated baseball match slot to the existing account service.
# Only mlp-social is restarted. BouncyBallBattle and HTTPS are not restarted.
set -Eeuo pipefail
trap 'printf "\nDedicated setup stopped at line %s. Send this output before retrying.\n" "$LINENO" >&2' ERR
release_url='https://github.com/joshgrof5-sudo/lobby-server/releases/download/server-v1.6.9/mlp-dedicated-1.6.9-linux-x86_64.tar.gz'
release_sha='7634e512563588974611abfe4e15d80e55a256956f640262d3389fc9054147bf'
app=/opt/mlp-social/app
node=/opt/mlp-social/runtime/bin/node
database=/var/lib/mlp-social/social.sqlite
dropin=/etc/systemd/system/mlp-social.service.d/dedicated.conf
[[ $(id -u) == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Run in the root Ubuntu x86_64 Droplet console.' >&2; exit 1; }
for tool in curl tar sha256sum ss awk install runuser systemctl systemd-analyze; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
[[ -x $node && -f $app/server.mjs && -f $database && ! -L $app && ! -L $database ]] || { echo 'The existing baseball installation was not found.' >&2; exit 1; }
[[ $release_sha =~ ^[0-9a-f]{64}$ ]] || { echo 'This installer has not been attached to a verified release yet.' >&2; exit 1; }
systemctl is-active --quiet mlp-social.service
# An upgrade may find our own match still running. Only accept listeners whose
# processes belong to the baseball systemd service; never stop another service.
listeners=$(ss -H -lnup 'sport = :7002')
if [[ -n $listeners ]]; then
    found_pid=0
    remaining=$listeners
    while [[ $remaining =~ pid=([0-9]+) ]]; do
        listener_pid=${BASH_REMATCH[1]}
        found_pid=1
        grep -Eq '/mlp-social\.service(/|$)' "/proc/$listener_pid/cgroup" || { echo 'UDP 7002 belongs to another service. No services were changed.' >&2; exit 1; }
        remaining=${remaining#*pid=$listener_pid}
    done
    (( found_pid == 1 )) || { echo 'Cannot identify the UDP 7002 listener. No services were changed.' >&2; exit 1; }
    echo 'An existing baseball match is running. This update will disconnect it when baseball restarts.'
fi
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
(( available_kb >= 393216 )) || { echo 'Less than 384 MiB is available. Send this output before installing a match slot.' >&2; exit 1; }
disk_kb=$(df -Pk /opt | awk 'NR==2 {print $4}')
(( disk_kb >= 524288 )) || { echo 'At least 512 MiB of free disk is needed.' >&2; exit 1; }
staging=$(mktemp -d /opt/mlp-social/dedicated-update.XXXXXXXX)
curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 --proto '=https' "$release_url" -o "$staging/release.tar.gz"
printf '%s  %s\n' "$release_sha" "$staging/release.tar.gz" | sha256sum --check -
while IFS= read -r member; do
    case "$member" in mlp-game.x86_64|mlp-game.pck|server.mjs|dedicated.mjs|inventory.mjs|cloud.mjs|cloud.test.mjs|equipment_catalog.json|package.json|server.test.mjs|matchmaking.test.mjs|inventory.test.mjs|dedicated.test.mjs|release.json|GODOT-LICENSE.txt) ;;
        *) echo "Unexpected release entry: $member" >&2; exit 1;; esac
done < <(tar -tzf "$staging/release.tar.gz")
install -d -m 0755 "$staging/source"
tar -xzf "$staging/release.tar.gz" -C "$staging/source" --no-same-owner
cd "$staging/source"
UV_THREADPOOL_SIZE=2 nice -n 15 "$node" --test --test-concurrency=1 server.test.mjs matchmaking.test.mjs inventory.test.mjs dedicated.test.mjs cloud.test.mjs
release=/opt/mlp-social/matches/releases/${release_sha:0:16}
install -d -m 0755 "$release"
install -m 0755 mlp-game.x86_64 "$release/mlp-game.x86_64"
install -m 0644 mlp-game.pck release.json GODOT-LICENSE.txt "$release/"
runuser -u mlp-social -- env HOME=/var/lib/mlp-social MLP_DEDICATED=1 MLP_DEDICATED_SELF_TEST=1 nice -n 15 "$release/mlp-game.x86_64" --headless > "$staging/pack-check.log" 2>&1
cat "$staging/pack-check.log"
grep -q 'DEDICATED PACK CHECK PASSED' "$staging/pack-check.log"

umask 077
install -d -m 0700 /var/lib/mlp-social/backups "$staging/previous"
backup=/var/lib/mlp-social/backups/$(basename "$staging").sqlite
"$node" --input-type=module - "$database" "$backup" <<'JS'
import {DatabaseSync,backup} from 'node:sqlite';
const source=new DatabaseSync(process.argv[2],{readOnly:true});
await backup(source,process.argv[3]);source.close();
JS
files=(server.mjs dedicated.mjs inventory.mjs cloud.mjs cloud.test.mjs equipment_catalog.json package.json server.test.mjs matchmaking.test.mjs inventory.test.mjs dedicated.test.mjs)
for file in "${files[@]}"; do if [[ -f $app/$file ]]; then cp "$app/$file" "$staging/previous/$file"; fi; done
if [[ -f $dropin ]]; then cp "$dropin" "$staging/previous/dedicated.conf"; fi
rollback() {
    trap - ERR
    echo 'Restoring the previous baseball service code/configuration. Accounts are kept.' >&2
    systemctl stop mlp-social.service || true
    for file in "${files[@]}"; do if [[ -f $staging/previous/$file ]]; then install -m 0644 "$staging/previous/$file" "$app/$file"; fi; done
    if [[ -f $staging/previous/dedicated.conf ]]; then install -m 0644 "$staging/previous/dedicated.conf" "$dropin"; else rm -f -- "$dropin"; fi
    systemctl daemon-reload
    systemctl start mlp-social.service || true
    printf 'Backup: %s\n' "$backup" >&2
    exit 1
}
systemctl stop mlp-social.service
trap rollback ERR
[[ -z $(ss -H -lnu 'sport = :7002') ]] || { echo 'UDP 7002 did not close after stopping baseball.' >&2; false; }
for file in "${files[@]}"; do install -m 0644 "$staging/source/$file" "$app/$file"; done
install -d -m 0755 /etc/systemd/system/mlp-social.service.d
cat > "$dropin" <<UNIT
[Service]
Environment=MLP_GAME_BINARY=$release/mlp-game.x86_64
Environment=MLP_GAME_PACK=$release/mlp-game.pck
Environment=MLP_GAME_ADDRESS=174.138.88.57
Environment=MLP_GAME_PORT=7002
Environment=MLP_MATCH_CAPACITY=1
MemoryHigh=384M
MemoryMax=512M
MemorySwapMax=96M
CPUQuota=70%
TasksMax=128
TimeoutStopSec=20
UNIT
systemd-analyze verify /etc/systemd/system/mlp-social.service
systemctl daemon-reload
systemctl start mlp-social.service
healthy=0
for attempt in {1..20}; do
    if "$node" --input-type=module -e "const r=await fetch('http://127.0.0.1:18081/health',{signal:AbortSignal.timeout(1500)});const d=await r.json();if(!r.ok||!d.dedicated_matches||d.game_version!=='1.5.4'||d.hockey_version!=='1.6.1-hockey'||d.server_release!=='1.6.9'||!d.hockey_cloud)process.exit(1)" 2>/dev/null; then healthy=1; break; fi
    sleep 1
done
(( healthy == 1 )) || rollback
trap - ERR
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 7002/udp comment 'Baseball dedicated match'; fi
printf '\nBASEBALL AND HOCKEY SERVER READY\n'
curl --fail --max-time 10 http://127.0.0.1:18081/health
printf '\nExisting other-game listener (UDP 7777):\n'
ss -lnup 'sport = :7777'
printf '\nMatch UDP 7002 opens when a match is allocated. HTTPS and the other game were not restarted.\n'
printf 'If a DigitalOcean cloud firewall is attached, allow inbound UDP 7002 there too.\nAccount backup: %s\n' "$backup"
