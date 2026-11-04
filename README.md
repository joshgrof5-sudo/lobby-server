# Major League Physics lobby server

For the existing DigitalOcean Droplet, see [DIGITALOCEAN.md](DIGITALOCEAN.md). It describes an isolated deployment alongside the other game, with separate account storage and a dedicated HTTPS hostname.

This branch adds unique account usernames, password sign-in, accepted friends, persistent parties and matchmaking for game version 1.2.0. The existing Python lobby list remains in the repository for older deployments. The new game requires `server.mjs`.

The DigitalOcean base service and HTTPS address have been verified. Run the newest `update-digitalocean.sh` from the Droplet's root console to deploy the account locker and matchmaking. It copies the new inventory module/catalog, tests the update, backs up SQLite, and restarts only baseball. See [the update instructions](DIGITALOCEAN.md#update-an-existing-installation-for-account-equipment-and-matchmaking). Earlier updater links do not copy the inventory module. Uploading this branch alone does not update the Droplet.

## Account equipment

Bats, helmets, equipped items, Club Cash and equipment quest progress are stored per account in SQLite. Signed-in clients load that locker on any computer. Purchases require authentication; the server checks daily UTC availability, its catalog price, balance and ownership transactionally. Duplicate purchases charge once. A party's public member profiles include only equipped gear and jersey number; private lockers and balances are never shared.

There is a one-time transfer of existing known local gear and cash to the first account using that old save. The legacy save is claimed server-side so it cannot be copied into another account; already-initialized lockers override a new device's local files. This compatibility import trusts the old offline save within catalog/balance limits. It is not cryptographic evidence of old purchases.

Future offline-mode rewards are reported by the game and retried from a durable outbox per account, with unique reward IDs preventing duplicate credits. Unsynchronized rewards remain pending on the device until it reconnects; committed purchases and loadouts are saved on the server. This HTTP service does not independently simulate offline gameplay. Career seasons and device preferences stay local.

Parties support one player plus six friends. The game renders all seven characters on its real field, with names, their saved helmets and bats mounted on their backs. Members' equipped gear updates through the normal party refresh.

## Online flow

Create a party or play alone, then choose **Find match**. Parties of up to seven stay on the same team. Matchmaking gathers up to 14 humans for 60 seconds (or starts early when full), gives connections a short grace period, and fills remaining positions with the game's bots. Players have 30 seconds to choose positions; unpicked positions are assigned automatically. Matches start automatically, and original parties remain together afterward. The UI has no public lobby browser or manual host/start controls.

## Friend requests

Requests are private to their sender and recipient. The recipient can accept or decline; the sender can cancel a pending request. Accepting adds the friendship to both accounts. Removing a friend clears the relationship and outstanding party invitations on both accounts. Requests and accepted friendships are saved in SQLite and survive server restarts. Only the owning account can act on a request.

The game updates friends every second while the panel is open, or within three seconds elsewhere. The Friends button counts pending requests and party invitations. Lists distinguish received requests, sent requests and accepted friends; statuses show Online, Offline, In a party, Finding a match or Playing. `npm test` covers these permissions and state changes. The game workspace also has a two-client UI test for automatic receipt, acceptance, party invitation/joining, removal and account switching.

## Update the existing Render service

Do not merge this branch into an automatically deployed Python service until its runtime and storage are configured. Deploy this branch directly while updating the runtime, or merge it and update the service configuration together.

1. Open **lobby-server-75iv** in the Render Dashboard. Under **Settings > Build > Source > Edit**, select this repository, the updated branch, and the **Node** runtime. Use build command `npm install` and start command `npm start`. Node 24 is selected by `.node-version`.
2. Attach a persistent disk mounted at `/var/data`. **Render requires a paid service for persistent disks.** Do not launch real accounts with an ephemeral database: usernames, passwords and friendships would be lost on redeploy. Review Render's pricing before purchasing anything.
3. Set environment variables `DATABASE_PATH=/var/data/social.sqlite` and `TRUST_PROXY=1`. Render provides `PORT`. Set the health check path to `/health`.
4. Deploy. Verify that `https://lobby-server-75iv.onrender.com/health` returns `{"service":"mlp-social","version":1}`. Keep one service instance using this disk. The existing game server URL can stay the same.
5. Test account creation, sign-in after restart, accepted friend requests, an invite, and two game clients joining the same party before releasing the game update.

Reference: [changing Render runtimes](https://render.com/docs/native-runtimes#changing-a-services-runtime), [persistent disks](https://render.com/docs/disks).

This branch has not been deployed just by adding these files. The old `python lobby_server.py` command continues running the old lobby list until Render's runtime/start command are changed. The Dockerfile is an alternative to the native Node runtime.

## Run locally

Node 24 or newer; no third-party dependencies:

```sh
npm test
npm start
```

Default port: 8080. Default database: `./data/social.sqlite`. For local game testing, set `MLP_SOCIAL_URL=http://127.0.0.1:8080` in the Godot process environment. Remote services require HTTPS.

## Account and multiplayer behavior

- Usernames are permanent, case-insensitive, 3–20 letters/digits/underscores, and start with a letter. A unique database constraint resolves simultaneous signups.
- Passwords use salted scrypt hashes; session tokens and connection tickets are stored as hashes. The game saves its session token, never its password. There is no password recovery flow yet.
- Friends must accept requests. Invites go to accepted friends. Joining by party code requires sign-in. Parties support 7 players for Online and 8 for legacy Derby. Matchmaking combines whole parties into matches with up to 14 humans.
- The ENet handshake checks one-use account tickets. Player-supplied display names cannot impersonate another account.
- Presence expires after 75 seconds. Friendships and account ownership survive restarts. Back up SQLite with its backup tools.
- Match hosts publish routes using authenticated matchmaking endpoints. Single-use match tickets verify players from different parties. Legacy private-party and lobby-list endpoints remain for older clients; the new UI uses matchmaking.

Game traffic still uses the game's ENet/UDP transport. The service provides account identity and party discovery, not a relay. Hosts need a reachable UDP port through UPnP, forwarding, or a reachable LAN.
