# Online accounts, friends and parties

For a shared DigitalOcean Droplet, see [DIGITALOCEAN.md](DIGITALOCEAN.md). Inspect the existing game's services before using the separate Compose deployment.

Version 1.3.2 uses dedicated Godot match processes. Install `install-dedicated-digitalocean.sh` before enabling the new Online client. The account-only updater does not install a game runtime. See [the server explanation](SERVER_SETUP.md) for the connection flow, limits and deployment steps.

The DigitalOcean account service is deployed at `https://mlp-174-138-88-57.sslip.io`. Live game checks confirm matchmaking and account inventory capabilities and authenticated account endpoints. The updater preserves the database and restarts only `mlp-social`.

On Windows, a TLS handshake failure can fall back to Windows' native HTTPS verifier. This supports antivirus scanning certificates already trusted by that computer; it does not disable certificate validation or install certificates. Request credentials pass through stdin rather than command arguments. `tools/check_live_server.gd` checks the deployed API without creating accounts or matches.

Signed-in accounts own their locker, Club Cash, quest progress and equipped bat/helmet in SQLite. Device preferences remain local. Purchases require sign-in and a successful server response; the server checks UTC offers, its catalog prices, balance and ownership in a transaction. A fresh device loads the account's saved locker. Party profiles expose only equipped gear, not anyone else's inventory or balance.

The first account using an old local save can transfer its existing known gear and Club Cash once. A server-side legacy-save claim prevents copying that save into another account; local transfer ownership also prevents a second account inheriting the first account's old device files. Already-initialized account lockers always take precedence over another computer's local files. This is a compatibility import of the old offline economy, not cryptographic proof of past earnings.

Future game-earned cash and quest progress are queued in a separate durable outbox per account and synchronized with idempotent reward IDs. The existing offline modes report these rewards; this service does not independently simulate their gameplay. Committed purchases and equipped items live on the server. Unsynchronized offline rewards remain pending on the device until it reconnects. Career seasons and video/control settings remain device-local.

## Run and test

Use Node 24 or newer. There are no third-party dependencies.

```sh
cd server
npm test
npm start
```

The API listens on port 8080 by default. `GET /health` returns `mlp-social`.

`node --test --test-concurrency=1 server.test.mjs matchmaking.test.mjs inventory.test.mjs dedicated.test.mjs dedicated-integration.test.mjs godot-integration.test.mjs friends-integration.test.mjs inventory-integration.test.mjs` also checks a real dedicated game with authenticated clients, leader departure, friend UIs, purchases and fresh-profile reloads. It renders seven party characters with separate gear. Set `GODOT_BIN` to your Godot 4.6 executable before running integration checks. Set `MLP_TEST_GAME_PACK` to test the exported server pack. Checks use temporary local ports and disposable profiles.


Friends refresh automatically every second while their panel is open, or within three seconds elsewhere. The Friends button counts pending requests and invitations. Incoming requests have Accept/Decline controls; sent requests can be cancelled. Friendships are mutual, requests survive server restarts, and switching accounts clears cached lists. Requests are private to the sender and recipient. The server rejects another account accepting, declining or cancelling someone else's request.

For local Godot testing, set `MLP_SOCIAL_URL=http://127.0.0.1:8080`. The game's `online/social_server_url` now points to `https://mlp-174-138-88-57.sslip.io`. The Render constant is only a fallback when that setting is absent.

## Hosting

Deploy `server/` as a Node service or use the Dockerfile. Set:

- `PORT`: the host's assigned HTTP port.
- `DATABASE_PATH`: a SQLite file **on a persistent disk**, for example `/data/social.sqlite`.
- `TRUST_PROXY=1` only behind the hosting provider's trusted reverse proxy, where `X-Forwarded-For` contains the real player address.

Run **one service instance** against that disk. Usernames and friend relationships must survive restarts. Do not put the database on ephemeral storage, and do not deploy independent SQLite instances behind a load balancer. Back up the database using SQLite's backup tools.

Online has no lobby browser or manual host/start controls. A party leader queues the complete party. The server assigns whole parties to Red/Blue (7 positions per team), searches for 60 seconds, and starts early if all 14 human slots fill. A short connection grace removes incomplete parties together. Connected players then get 30 seconds to pick unique positions, with automatic assignment for players who do not pick. The game starts automatically and uses its existing bots in empty positions. Original parties survive cancellation and returning from the match.

Parties remain on the account service without opening ENet. A match opens a single host connection and uses match-scoped one-use tickets, so different parties can play together while keeping their account identities. The old `/lobbies` and private-party ticket endpoints remain for older clients; the new UI does not browse them.

Online game transport is ENet/UDP to a dedicated Godot process. The party leader does not host a match. Clients never publish the dedicated route or start the game; only the authenticated worker can do that. Home-router port forwarding is unnecessary. Allow the dedicated UDP port on the Droplet. Legacy peer-hosted API routes remain only for older/manual clients and tests; the new matchmaking client does not use them.

## Identity rules

- Usernames are permanent, case-insensitive, 3–20 ASCII letters/digits/underscores, starting with a letter. A unique database constraint enforces ownership, including concurrent signups.
- Passwords use salted scrypt hashes. Only hashed session tokens and short-lived connection tickets are stored server-side. Passwords are never saved by the game.
- Online host and client identities are checked through single-use server tickets during ENet authentication. Display names and RPC-supplied names cannot claim an account's username.
- Friend requests require acceptance. Party invitations can be sent only to accepted friends. Joining by party code requires a signed-in account. Only the party leader can publish routes or start an existing hosted game.
- Parties support 7 players for Online or 8 for legacy Derby. Online matches support 14 humans plus bot-filled positions. Offline users expire from parties after 75 seconds without presence updates; accepted friendships remain saved.

There is no password recovery UI in this version. Keep the password you choose; adding a recovery provider requires a separate email/account service.
