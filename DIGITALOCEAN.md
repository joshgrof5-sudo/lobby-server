# Share the existing DigitalOcean Droplet

Target: `174.138.88.57`. The account service and HTTPS proxy are installed separately from the existing game.

## Dedicated matches in 1.4.0

Use `install-dedicated-digitalocean.sh` for the next deployment. The tested archive contains a stripped Godot game pack, Linux runtime and backend modules. The installer verifies its pinned checksum, tests the pack and backend, backs up accounts, and restarts only `mlp-social`. It installs one dedicated match slot on UDP 7002 and a resource-limited systemd drop-in. The other game keeps UDP 7777. An attached DigitalOcean cloud firewall also needs inbound UDP 7002.

The new Online client requires `dedicated_matches:true` and never creates a player-hosted match. See [SERVER_SETUP.md](SERVER_SETUP.md) for the full explanation. This dedicated deployment is separate from the already-live account/matchmaking update below.

## Update an existing installation for account equipment and matchmaking

The account-locker and matchmaking update has been deployed. Live Godot HTTPS checks confirm `"matchmaking":true` and `"account_inventory":true`, and protected endpoints reject unauthenticated requests. For future updates, the newest `update-digitalocean.sh` stages the source including `inventory.mjs` and `equipment_catalog.json`, runs backend tests sequentially with reduced CPU priority, takes a consistent SQLite backup under `/var/lib/mlp-social/backups`, and restarts only `mlp-social`. If health checks fail, it restores previous server modules and keeps the database. It does not restart HTTPS, the other game, or change firewall rules.

The previous 1.2 deployment provides accounts and player-hosted matchmaking. The 1.4.0 build changes match traffic to a dedicated Godot process, while keeping the same account database and HTTPS address.

## Native setup for this Droplet (no Docker required)

The inspected machine is Ubuntu 24.04 x86_64 with about 1 GiB RAM, 575 MiB currently available, the existing game on UDP 7777, and no Node/Docker/reverse proxy installed. `install-digitalocean.sh` is an initial installer for that setup. Run it as root only after inspecting the host.

The installer checks for collisions and at least 400 MiB available RAM, downloads Node 24 from nodejs.org and verifies the archive's SHA-256 against its published manifest, clones this feature branch, and runs the server tests. It installs Node privately under `/opt/mlp-social/runtime`, adds the `mlp-social` service account and systemd unit, and stores accounts in `/var/lib/mlp-social`. It does not change the system Node, install packages, restart the other game, or change firewall/proxy settings. It refuses to overwrite an existing deployment.

The service listens only on `127.0.0.1:18081`, limits password hashing to two concurrent requests, and has a 320 MiB memory ceiling and 40% of one CPU. Resource limits reduce interference, but the other game's peak usage still needs monitoring. Only this service restarts on failure. The installer reports its health and the current UDP 7777 listener when done. A trusted HTTPS hostname and proxy are a separate, later step; the game URL must not change before that is verified.

```sh
bash install-digitalocean.sh
```

For diagnostics: `systemctl status mlp-social --no-pager` and `journalctl -u mlp-social -n 30 --no-pager`. To stop only baseball: `systemctl stop mlp-social`. Keep its data directory when rolling back. The Compose instructions below are an alternative for machines that already use Docker.

### HTTPS without an owned domain

After the native service is healthy, `install-https-digitalocean.sh` adds a separate Caddy 2.11.7 proxy using `mlp-174-138-88-57.sslip.io`. This free DNS hostname depends on the third-party sslip.io service and the Droplet keeping its IP. It can be replaced by an owned domain later.

The script refuses occupied TCP 80/443, downloads the official Caddy binary with a pinned SHA-512 checksum, validates its configuration, and adds only the `mlp-social-https` service with its own user and certificate storage. The proxy has a 160 MiB memory ceiling and 20% of one CPU. It does not restart the account service or the other game. Only TCP HTTP/HTTPS is enabled (no QUIC/UDP listener). If UFW is already active, it adds TCP 80 and 443 allow rules without enabling/resetting the firewall or changing game/SSH rules. A separate DigitalOcean cloud firewall may still need matching inbound rules.

Run as root after reviewing the script:

```sh
bash install-https-digitalocean.sh
```

The script checks trusted HTTPS locally using the real hostname and certificate verification. External reachability must be checked separately before changing `online/social_server_url`. If certificate verification times out, do not rerun the initial installer: inspect `journalctl -u mlp-social-https -n 30 --no-pager`, DNS and firewall rules instead. Stopping only the proxy is `systemctl stop mlp-social-https`; keep `/var/lib/mlp-social-https` for certificate renewals.

First inspect the machine. Keep the existing game's services, ports, proxy configuration, containers and storage. Do not run a global Docker cleanup, replace the default proxy site, restart Docker, or flush firewall rules.

## 1. Inspect before installing or starting anything

Run these in the Droplet's browser console or an authenticated SSH session. Share the output without passwords, keys or environment files:

```sh
uname -a
free -h
df -h /
sudo ss -lntup
command -v docker node nginx caddy
sudo systemctl is-active nginx caddy apache2
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

Missing commands are useful information. Check available memory and whether loopback TCP 18081 is free. The supplied container is capped at 512 MiB RAM and half a CPU; these limits must be assessed against the other game's peak usage. If Docker is absent, choose an isolated Node 24/systemd deployment or review a Docker install before altering the host.

## 2. Run the separate baseball service

Only after confirming Docker Compose is installed, resources are available and 18081 is unused, copy this server directory into its own deployment directory (for example `/opt/mlp-social`). Run commands from that directory:

```sh
sudo docker compose -f compose.digitalocean.yaml -p mlp-social build
sudo docker compose -f compose.digitalocean.yaml -p mlp-social up -d social
curl --fail http://127.0.0.1:18081/health
```

Expected response: `{"service":"mlp-social","version":1}`. The database is stored in this project's named volume, separate from the other game. Do not use `down -v`: it deletes account data. Back up SQLite using SQLite's backup mechanism, not by copying an actively written database file alone.

This container exposes only loopback TCP 18081. It does not claim public ports 80/443 or any game UDP ports. Its log files are bounded. The resource limits reduce contention; they do not guarantee spare capacity on an overloaded Droplet.

## 3. Route a dedicated HTTPS hostname

Choose a subdomain such as `baseball.yourdomain.com` and point its A record to `174.138.88.57`. Reuse whichever reverse proxy already owns ports 80/443. Do not install a second proxy on those ports.

For host-installed Nginx, `nginx.digitalocean.conf.example` is a new, separate site template. Replace its example hostname, add the site without changing the other game's site, and run `sudo nginx -t` before reloading Nginx. Use the host's existing certificate manager to add a trusted HTTPS certificate for just the new hostname. Keep the other game's certificates and configuration.

If Nginx is containerized, its `127.0.0.1` is inside that container: the host template cannot be used as-is. Inspect the existing Docker networks and proxy routing first. Caddy, Traefik, Apache and other proxies likewise require a configuration adapted to their existing setup.

Verify both games' existing URLs and the new `https://YOUR_HOSTNAME/health` after routing. Keep the backend port private. Confirm that the proxy replaces the incoming X-Forwarded-For header with the real client address, because `TRUST_PROXY=1` uses it for host routes and rate limits.

## 4. Switch the game after checking the server

Set this in the game's `project.godot` only after HTTPS is working:

```ini
[online]
social_server_url="https://YOUR_HOSTNAME"
```

Test new account registration, sign-in, friends, party invitations and a real multiplayer match. Restart only the baseball container and verify that account sign-in still works. Recheck the other game. Keep the Render address unchanged in released builds until the replacement has been verified.

The account service does not relay match traffic. Actual matches still use the existing host-to-player ENet transport, independently of this Droplet's other game.

## Stop or roll back only this service

```sh
sudo docker compose -f compose.digitalocean.yaml -p mlp-social stop social
```

This keeps the account volume. Remove only the new proxy site if rolling back routing, validate/reload that proxy, and retain the other game's configuration.
