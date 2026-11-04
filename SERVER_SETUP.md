# How Online works in 1.4.0

The account service is already live. The dedicated-match build must be installed on the Droplet before the new Online client can find a match. The new client never falls back to running a match on a player's PC.

```mermaid
flowchart LR
    A[Your game] -->|HTTPS 443: account, saves, friends, party, matchmaking| API[Account service on the Droplet]
    B[Friends' games] -->|HTTPS 443| API
    API --> DB[(Persistent SQLite accounts and lockers)]
    API -->|Allocates a separate process| Match[Dedicated Godot match on the Droplet]
    A <-->|ENet / UDP 7002| Match
    B <-->|ENet / UDP 7002| Match
    Other[BouncyBallBattle / UDP 7777]
```

Your computer reads controls, updates its local movement/camera, and renders the field and characters. It sends movement, swing and interaction updates to the match server. The match server runs bot AI, match rules, ball simulation and scoring, then sends game and animation updates to every player. It has no playable host character. Everyone connects as a client.

The party leader controls invitations and the Find Match button. That is a group-management role, not a game server. If the leader leaves a party, leadership transfers to a remaining member. Their match continues on the Droplet, and the existing match logic replaces departed players with bots.

Matchmaking searches for up to one minute, keeps party members on the same team, and fills the other positions with bots. Once complete groups connect, players pick positions; after 30 seconds, unpicked positions are assigned and the server starts the game. One-use account tickets and account-bound server receipts verify both sides of the connection.

Bats, helmets, equipped items, Club Cash and quest progress are stored in `/var/lib/mlp-social/social.sqlite`. Accounts and accepted friendships survive restarts. Unsynchronized offline rewards remain queued on the device until it reconnects; career seasons and control/video settings remain local.

The shared 1 GB Droplet starts with **one concurrent baseball match**, supporting up to 14 humans. Further groups wait for that slot. The Godot process uses a headless renderer, no audio, and a 30 Hz server physics tick. The account service and its game worker share a 512 MiB hard memory limit and a 70% CPU ceiling, with low scheduling priority. These limits protect the other game from unbounded baseball load; the Droplet still needs a real load check after deployment.

The account HTTPS proxy remains on TCP 80/443. Baseball matches use **UDP 7002**. BouncyBallBattle keeps **UDP 7777**. Players do not need to forward ports on their home routers. If the Droplet has a DigitalOcean cloud firewall, add an inbound UDP 7002 rule there; an active UFW firewall is handled by the installer.

## Install on the existing Droplet

Use `server/install-dedicated-digitalocean.sh` from the published, pinned backend commit. It downloads the pinned archive, verifies SHA-256, runs backend tests, loads the actual headless field in a self-test, backs up SQLite, and adds the dedicated-game environment through a systemd drop-in. It restarts only `mlp-social`. It leaves HTTPS and the other game's service running. Failed health checks restore the previous baseball code/configuration and keep account data.

Success prints `DEDICATED BASEBALL SERVER READY`. The live `/health` response must then contain `"dedicated_matches":true` and `"game_version":"1.4.0"`. A match worker opens UDP 7002 when a match is allocated; that port is normally idle between matches.

Use the rebuilt `MajorLeaguePhysics.exe` on every player's computer. Old 1.2 clients cannot join 1.4.0 dedicated matches.

Version 1.4.0 streams the actual full-body poses and equipment of human players as well as bots. Human poses travel on a separate small unreliable-ordered channel and are relayed by the dedicated server. Observers interpolate the recorded joints and skin instead of running another spring/IK simulation for a player holding the ball. Interaction event numbers reject poses sent before a punch or throw.

The runtime retains the mound collision and mitt calibration even when graphics are stripped. Remote human equipment has one network owner; observer IK reads its final pose instead of repeatedly rotating or fitting it.

Player colliders, gloves and rigs retain their stable peer-based names and ordered interaction effects from 1.3.3. Fielding and running speed is 25% higher than that build, with stronger acceleration and braking. The bottom punch/grab hint is removed.

Each graphical client keeps a bounded 12-second recording of real athlete poses and baseball transforms at 20 Hz. Hits, home runs, outs, fouls and walks mark highlights. Once the live play is resolved, the server broadcasts one replay event and holds the next pitch for six seconds. Clients replay the contact and key finish using inert visual copies on the actual field, a moving camera and a Back to field button. Playback never changes the live ball, physics, scores, inventory or player transforms. Original cameras and HUD visibility return afterward; a local skip does not shorten the shared online pitch hold. The dedicated worker records no meshes or video and remains headless. Season completion waits for the final highlight before returning to its hub.

While fielding with an empty throwing hand, aim at a nearby teammate and tap left click to punch, hold to grab, and release to throw. The same tap/hold/release behavior uses the remappable controller grab button. Existing hand-sweep punches remain supported. A release that happens before the grab acknowledgement is buffered with its original aim. Server validation checks nearby bodies and world occlusion instead of a delayed animated hand position. Carrying uses a damped spring that remains stable across frame rates. Spectators, opponents and players beyond reach are not interaction targets; holding a baseball keeps the normal baseball throw controls.
