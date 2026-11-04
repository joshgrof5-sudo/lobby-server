#!/usr/bin/env bash
# Updates only the existing baseball account service. Keeps accounts, proxy,
# firewall, system Node and the other game's service unchanged.
set -Eeuo pipefail
trap 'printf "\nUpdate stopped at line %s. Send this output before retrying.\n" "$LINENO" >&2' ERR
node=/opt/mlp-social/runtime/bin/node
app=/opt/mlp-social/app
database=/var/lib/mlp-social/social.sqlite
[[ $(id -u) == 0 && -x $node && -f $app/server.mjs ]] || { echo 'Run from the root console after the baseball installation.' >&2; exit 1; }
[[ -f $database && ! -L $database && ! -L $app ]] || { echo 'Unexpected deployment layout. Stop and send this output.' >&2; exit 1; }
systemctl is-active --quiet mlp-social.service || { echo 'Baseball is not currently running. Send this output.' >&2; exit 1; }
staging=$(mktemp -d /opt/mlp-social/update.XXXXXXXX)
git clone --depth 1 --branch feature/accounts-friends-parties https://github.com/joshgrof5-sudo/lobby-server.git "$staging/source"
cd "$staging/source"
UV_THREADPOOL_SIZE=2 nice -n 15 "$node" --test --test-concurrency=1 server.test.mjs matchmaking.test.mjs inventory.test.mjs

umask 077
install -d -m 0700 /var/lib/mlp-social/backups "$staging/previous"
backup=/var/lib/mlp-social/backups/$(basename "$staging").sqlite
# SQLite's online backup includes committed WAL data without stopping the app.
"$node" --input-type=module - "$database" "$backup" <<'JS'
import {DatabaseSync,backup} from 'node:sqlite';
const source=new DatabaseSync(process.argv[2],{readOnly:true});
await backup(source,process.argv[3]);
source.close();
JS
for file in server.mjs package.json server.test.mjs matchmaking.test.mjs inventory.mjs equipment_catalog.json inventory.test.mjs; do
    if [[ -f $app/$file ]]; then cp "$app/$file" "$staging/previous/$file"; fi
done
systemctl stop mlp-social.service
rollback() {
    trap - ERR
    echo 'The new service did not verify. Restoring the previous baseball server code.' >&2
    systemctl stop mlp-social.service || true
    for file in server.mjs package.json server.test.mjs matchmaking.test.mjs inventory.mjs equipment_catalog.json inventory.test.mjs; do
        if [[ -f $staging/previous/$file ]]; then install -m 0644 "$staging/previous/$file" "$app/$file"; fi
    done
    systemctl start mlp-social.service || true
    printf 'Accounts were kept. Backup: %s\n' "$backup" >&2
    exit 1
}
trap rollback ERR
for file in server.mjs package.json server.test.mjs matchmaking.test.mjs inventory.mjs equipment_catalog.json inventory.test.mjs; do
    install -m 0644 "$staging/source/$file" "$app/$file"
done
systemctl start mlp-social.service
healthy=0
for attempt in {1..20}; do
    if "$node" --input-type=module -e "const r=await fetch('http://127.0.0.1:18081/health',{signal:AbortSignal.timeout(1500)});const d=await r.json();if(!r.ok||d.service!=='mlp-social'||d.matchmaking!==true||d.account_inventory!==true)process.exit(1)" 2>/dev/null; then
        healthy=1
        break
    fi
    sleep 1
done
(( healthy == 1 )) || rollback
trap - ERR
printf '\nACCOUNT LOCKER AND MATCHMAKING READY\nAccount backup: %s\n' "$backup"
curl --fail --max-time 10 http://127.0.0.1:18081/health
printf '\nExisting game UDP listeners:\n'
ss -lnup 'sport = :7777'
printf '\nOnly mlp-social was restarted. HTTPS and the other game were not restarted.\n'
