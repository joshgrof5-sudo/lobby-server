import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createCloud} from './cloud.mjs';
import {createInventory} from './inventory.mjs';
import {createDedicatedPool} from './dedicated.mjs';

const scrypt = promisify(scryptCallback);
const id = () => randomBytes(16).toString('hex');
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value ?? '').trim().toLowerCase();
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(value, status, message) { if (!value) throw new ApiError(status, message); }

export function createService({ database = ':memory:', clock = () => Date.now(), trustProxy = false, authLimit = 12, authConcurrency = 6, dedicated = null } = {}) {
  if (!Number.isInteger(authConcurrency) || authConcurrency < 1 || authConcurrency > 6) throw new Error('AUTH_CONCURRENCY must be an integer from 1 to 6.');
  if (database !== ':memory:') mkdirSync(dirname(resolve(database)), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS friends(a TEXT NOT NULL REFERENCES users(id), b TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(a,b), CHECK(a<b));
    CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES users(id), receiver TEXT NOT NULL REFERENCES users(id), UNIQUE(sender,receiver), CHECK(sender<>receiver));
    CREATE TABLE IF NOT EXISTS parties(id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, host TEXT NOT NULL REFERENCES users(id), ip TEXT NOT NULL, lan_ip TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 7000, mode TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL DEFAULT '1.1.0');
    CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY REFERENCES users(id), party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES users(id), receiver TEXT NOT NULL REFERENCES users(id), party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE, UNIQUE(receiver,party_id));
    CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,host_party TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,phase TEXT NOT NULL,created INTEGER NOT NULL,deadline INTEGER NOT NULL,selection_deadline INTEGER NOT NULL DEFAULT 0,version TEXT NOT NULL,ip TEXT NOT NULL DEFAULT '',lan_ip TEXT NOT NULL DEFAULT '',port INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS match_parties(party_id TEXT PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,team TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS match_members(user_id TEXT PRIMARY KEY REFERENCES users(id),match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,ready INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS match_tickets(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
  `);
  const inventory=createInventory(db,clock);
  const cloud=createCloud(db,clock);
  if(!db.prepare('PRAGMA table_info(matches)').all().some(column=>column.name==='dedicated'))db.exec('ALTER TABLE matches ADD COLUMN dedicated INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(matches)').all().some(column=>column.name==='mode'))db.exec("ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'classic'");
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const limits = new Map();
  let activeAuth = 0;
  const now = () => Math.floor(clock() / 1000);
  const publicUser = user => ({ id: user.id, username: user.username });
  const pair = (a,b) => a < b ? [a,b] : [b,a];
  const areFriends = (a,b) => a !== b && !!one('SELECT 1 FROM friends WHERE a=? AND b=?', ...pair(a,b));
  const membership = user => one('SELECT p.* FROM parties p JOIN members m ON p.id=m.party_id WHERE m.user_id=?', user);
  const userMatch = userId => one('SELECT g.* FROM matches g JOIN match_members m ON m.match_id=g.id WHERE m.user_id=?',userId);
  const pool=dedicated?createDedicatedPool(dedicated,match=>run('DELETE FROM matches WHERE id=?',match),()=>`http://127.0.0.1:${server.address().port}`):null;
  const cancelGroup = party => {
    const entry=one('SELECT * FROM match_parties WHERE party_id=?',party.id);
    if(!entry)return;
    const game=one('SELECT * FROM matches WHERE id=?',entry.match_id);
    if(game.dedicated && game.phase!=='searching'){
      run('DELETE FROM match_members WHERE party_id=?',party.id);
      run('DELETE FROM match_parties WHERE party_id=?',party.id);
      // Keep the match's anchor party until the dedicated process finishes.
      return;
    }
    if(game.host_party===party.id)run('DELETE FROM matches WHERE id=?',game.id);
    else {
      run('DELETE FROM match_members WHERE party_id=?',party.id);
      run('DELETE FROM match_parties WHERE party_id=?',party.id);
      run('DELETE FROM match_tickets WHERE match_id=? AND user_id NOT IN (SELECT user_id FROM match_members WHERE match_id=?)',game.id,game.id);
    }
  };
  const advanceMatches = () => {
    for(const game of all("SELECT * FROM matches WHERE phase IN ('searching','connecting')")) {
      const count=one('SELECT COUNT(*) AS n FROM match_members WHERE match_id=?',game.id).n;
      if(game.phase==='searching' && (now()>=game.deadline || count===(game.mode==='hockey'?10:14))){
        if(game.dedicated && !pool.ensure(game))continue;
        run("UPDATE matches SET phase='connecting',deadline=? WHERE id=?",now()+(game.dedicated?45:15),game.id);
      }
      const current=one('SELECT * FROM matches WHERE id=?',game.id);
      if(current.phase!=='connecting')continue;
      if(current.dedicated && !pool.workers.get(game.id)?.ready)continue;
      const missing=one('SELECT COUNT(*) AS n FROM match_members WHERE match_id=? AND ready=0',game.id).n;
      if(missing && now()<current.deadline)continue;
      if(missing) {
        for(const group of all('SELECT DISTINCT p.* FROM parties p JOIN match_members m ON m.party_id=p.id WHERE m.match_id=? AND m.ready=0',game.id)){
          if(current.dedicated){run('DELETE FROM match_members WHERE party_id=?',group.id);if(group.id!==current.host_party)run('DELETE FROM match_parties WHERE party_id=?',group.id);}
          else cancelGroup(group);
        }
      }
      if(one('SELECT 1 FROM matches WHERE id=?',game.id))run("UPDATE matches SET phase='selecting',selection_deadline=? WHERE id=?",now()+30,game.id);
    }
  };
  const authenticated = req => {
    const authorization = req.headers.authorization ?? '';
    requireValue(/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization), 401, 'Sign in to continue.');
    const user = one('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.hash=? AND s.expires>?', digest(authorization.slice(7)), now());
    requireValue(user, 401, 'Your session expired. Sign in again.');
    return user;
  };
  const ipFor = req => {
    const raw = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : req.socket.remoteAddress;
    const ip = String(raw ?? '').replace(/^::ffff:/, '');
    requireValue(isIP(ip), 400, 'Could not identify your connection.');
    return ip;
  };
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const cleanup = () => {
    run('DELETE FROM sessions WHERE expires<=?', now());
    run('DELETE FROM tickets WHERE expires<=?', now());
    run('DELETE FROM match_tickets WHERE expires<=?', now());
    for(const user of all('SELECT id FROM users WHERE seen<? AND id IN (SELECT user_id FROM members)',now()-75))leaveParty(user.id);
    run('DELETE FROM parties WHERE NOT EXISTS(SELECT 1 FROM members WHERE party_id=parties.id) AND NOT EXISTS(SELECT 1 FROM matches WHERE host_party=parties.id)');
    advanceMatches();
    if(pool)pool.sweep(new Set(all('SELECT id FROM matches WHERE dedicated=1').map(g=>g.id)));
  };
  const matchView = game => {
    if(!game)return null;
    const leader=one('SELECT u.id,u.username FROM users u JOIN parties p ON p.host=u.id WHERE p.id=?',game.host_party);
    const members=all('SELECT u.id,u.username,m.party_id,m.ready,p.team FROM match_members m JOIN users u ON u.id=m.user_id JOIN match_parties p ON p.party_id=m.party_id WHERE m.match_id=? ORDER BY u.username',game.id).map(member=>({...member,equipped:{...inventory.publicGear(member.id),...cloud.gear(member.id)}}));
    return {...game,dedicated:!!game.dedicated,host_id:game.dedicated?'dedicated':leader.id,host_username:game.dedicated?'Match server':leader.username,members,max:game.mode==='hockey'?10:14,bots:(game.mode==='hockey'?10:14)-members.length,server_now:now(),remaining:Math.max(0,game.deadline-now()),selection_remaining:Math.max(0,game.selection_deadline-now())};
  };
  const partyView = party => {
    if (!party) return null;
    const host = one('SELECT id,username FROM users WHERE id=?', party.host);
    const members = all('SELECT u.id,u.username FROM users u JOIN members m ON u.id=m.user_id WHERE m.party_id=? ORDER BY u.username', party.id).map(member=>({...member,equipped:{...inventory.publicGear(member.id),...cloud.gear(member.id)}}));
    const game=one('SELECT g.phase FROM matches g JOIN match_parties p ON p.match_id=g.id WHERE p.party_id=?',party.id);
    return { id: party.id, code: party.code, host_id: host.id, host_username: host.username, ip: party.ip, lan_ip: party.lan_ip, port: party.port, mode: party.mode,
      started: !!party.started || game?.phase==='playing', public: !!party.public, max: party.mode === 'derby' ? 8 : party.mode==='hockey'?5:7, members, version: party.version, matchmaking:!!game, phase:game?.phase ?? 'party' };
  };
  const leaveParty = userId => {
    const party = membership(userId);
    if (!party) return;
    const game=userMatch(userId);
    if(!game?.dedicated&&!one('SELECT 1 FROM matches WHERE host_party=? AND dedicated=1',party.id)){cancelGroup(party);if(party.host===userId)run('DELETE FROM parties WHERE id=?',party.id);else run('DELETE FROM members WHERE user_id=?',userId);return;}
    if(game?.dedicated && game.phase!=='searching')run('DELETE FROM match_members WHERE user_id=?',userId);
    else if(game)cancelGroup(party);
    run('DELETE FROM members WHERE user_id=?', userId);
    const next=one('SELECT user_id FROM members WHERE party_id=? ORDER BY user_id LIMIT 1',party.id);
    if(party.host===userId&&next)run('UPDATE parties SET host=? WHERE id=?',next.user_id,party.id);
    if(!next&&!one('SELECT 1 FROM matches WHERE host_party=? AND dedicated=1',party.id))run('DELETE FROM parties WHERE id=?',party.id);
  };
  const state = user => ({
    user: publicUser(user), inventory:inventory.view(user.id),party: partyView(membership(user.id)), match:matchView(userMatch(user.id)),
    friends: all('SELECT u.id,u.username,u.seen FROM users u JOIN friends f ON (f.a=? AND f.b=u.id) OR (f.b=? AND f.a=u.id) ORDER BY u.username', user.id,user.id)
      .map(friend => { const party = membership(friend.id); return { ...publicUser(friend), online: friend.seen >= now()-60, party: friend.seen >= now()-60 ? partyView(party) : null }; }),
    incoming: all('SELECT r.id,u.username FROM requests r JOIN users u ON r.sender=u.id WHERE r.receiver=? ORDER BY u.username', user.id),
    outgoing: all('SELECT r.id,u.username FROM requests r JOIN users u ON r.receiver=u.id WHERE r.sender=? ORDER BY u.username', user.id),
    invites: all('SELECT i.id,i.party_id,u.username FROM invites i JOIN users u ON u.id=i.sender WHERE i.receiver=?', user.id)
      .map(invite => ({ ...invite, party: partyView(one('SELECT * FROM parties WHERE id=?', invite.party_id)) })),
    sent_invites: all('SELECT i.id,u.username FROM invites i JOIN users u ON u.id=i.receiver WHERE i.sender=?',user.id),
  });
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length; requireValue(size <= (req.url==='/v1/cloud/hockey'?2097152:8192), 413, 'Request is too large.'); chunks.push(chunk);
    }
    try { const data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); requireValue(data && typeof data === 'object' && !Array.isArray(data),400,'Invalid request.'); return data; }
    catch { throw new ApiError(400, 'Invalid request.'); }
  }
  async function route(req) {
    const url = new URL(req.url, 'http://localhost'); const path = url.pathname; const method = req.method;
    cleanup();
    if (method === 'GET' && (path === '/' || path === '/health')) return { service: 'mlp-social', version: 1, matchmaking:true, account_inventory:true,dedicated_matches:!!pool,game_version:'1.5.4',server_release:'1.6.5',hockey_version:'1.6.1-hockey',hockey_cloud:true,sports:['baseball','hockey'] };
    if(method==='POST'&&path==='/internal/match'){
      const data=await body(req),worker=pool?.authenticate(String(data.match_id??''),req.headers['x-mlp-worker']);
      requireValue(worker,403,'Invalid match worker.');
      const game=one('SELECT * FROM matches WHERE id=? AND dedicated=1',data.match_id);
      requireValue(game,404,'Match ended.');worker.seen=Date.now();
      if(data.action==='listening'){
        worker.ready=true;run('UPDATE matches SET ip=?,port=? WHERE id=?',dedicated.address,worker.port,game.id);
      }else if(data.action==='verify'){
        const proof=one('SELECT * FROM match_tickets WHERE hash=? AND match_id=? AND expires>?',digest(String(data.ticket??'')),game.id,now());
        requireValue(proof&&userMatch(proof.user_id)?.id===game.id&&(['connecting','searching'].includes(game.phase)||(game.mode==='hockey'&&['selecting','playing'].includes(game.phase))),403,'Player is not joining this match.');
        run('DELETE FROM match_tickets WHERE hash=?',proof.hash);
        return {user:{...publicUser(one('SELECT * FROM users WHERE id=?',proof.user_id)),equipped:{...inventory.publicGear(proof.user_id),...cloud.gear(proof.user_id)}},receipt:pool.issueReceipt(game.id,proof.user_id)};
      }else if(data.action==='start'){
        requireValue(game.phase==='selecting',409,'Match is not selecting.');run("UPDATE matches SET phase='playing' WHERE id=?",game.id);
      }else if(data.action==='finish'){
        run('DELETE FROM matches WHERE id=?',game.id);return {finished:true};
      }else requireValue(data.action==='state',400,'Unknown worker action.');
      return {match:matchView(one('SELECT * FROM matches WHERE id=?',game.id))};
    }
    if (method === 'GET' && path === '/lobbies') {
      return all('SELECT * FROM parties WHERE public=1 AND started=0 AND version=?', url.searchParams.get('v') || '1.1.0').map(p => ({ ...partyView(p), name: one('SELECT username FROM users WHERE id=?',p.host).username, players: one('SELECT COUNT(*) AS n FROM members WHERE party_id=?',p.id).n }));
    }
    if (path === '/v1/auth/register' || path === '/v1/auth/login') {
      requireValue(method === 'POST',405,'Use POST.');
      const key = ipFor(req), bucket = limits.get(key) ?? { count: 0, until: clock()+60000 };
      if (bucket.until <= clock()) { bucket.count=0; bucket.until=clock()+60000; }
      bucket.count++; limits.set(key,bucket);
      if (limits.size > 10000) for (const [address,entry] of limits) if (entry.until <= clock()) limits.delete(address);
      requireValue(bucket.count <= authLimit,429,'Too many attempts. Try again in a minute.');
      requireValue(activeAuth < authConcurrency,503,'Sign-in is busy. Try again shortly.');
      const data = await body(req); const username = normalize(data.username); const password = String(data.password ?? '');
      requireValue(/^[a-z][a-z0-9_]{2,19}$/.test(username),400,'Use 3–20 letters, numbers or underscores, starting with a letter.');
      requireValue(password.length >= 10 && Buffer.byteLength(password) <= 256,400,'Use a password with 10–256 characters.');
      activeAuth++;
      try {
        let user = one('SELECT * FROM users WHERE username=?',username);
        if (path.endsWith('/register')) {
          requireValue(!user,409,'That username is already taken.');
          const salt = randomBytes(16).toString('hex');
          const hash = await scrypt(password,salt,64,{ N:32768,r:8,p:1,maxmem:64*1024*1024 });
          user = { id:id(), username, salt, password_hash:hash.toString('hex') };
          try { run('INSERT INTO users VALUES(?,?,?,?,?)', user.id,username,salt,user.password_hash,now()); }
          catch(error) { if (String(error.message).includes('UNIQUE')) throw new ApiError(409,'That username is already taken.'); throw error; }
        } else {
          // Derive even for unknown accounts to avoid a fast account-enumeration path.
          const salt = user?.salt ?? '00000000000000000000000000000000';
          const hash = await scrypt(password,salt,64,{ N:32768,r:8,p:1,maxmem:64*1024*1024 });
          requireValue(user && timingSafeEqual(hash,Buffer.from(user.password_hash,'hex')),401,'Username or password is incorrect.');
          run('UPDATE users SET seen=? WHERE id=?',now(),user.id);
        }
        const access = token();
        run('INSERT INTO sessions VALUES(?,?,?)',digest(access),user.id,now()+30*86400);
        return { token:access, user:publicUser(user) };
      } finally { activeAuth--; }
    }
    const user = authenticated(req);
    if(path==='/v1/cloud/hockey'){
      if(method==='GET')return cloud.read(user.id);
      requireValue(method==='POST',405,'Use GET or POST.');
      const data=await body(req);return cloud.write(user.id,data);
    }
    if(method==='POST'&&path==='/v1/dedicated/verify-server'){
      const data=await body(req),game=userMatch(user.id);
      requireValue(game?.dedicated&&pool.consumeReceipt(String(data.receipt??''),game.id,user.id),403,'Could not verify the match server.');return {verified:true,match_id:game.id};
    }
    if (method === 'POST' && path === '/v1/auth/logout') {
      leaveParty(user.id); run('DELETE FROM sessions WHERE hash=?',digest(req.headers.authorization.slice(7))); return { ok:true };
    }
    if (method === 'GET' && path === '/v1/me') return { user:publicUser(user) };
    if (method === 'GET' && path === '/v1/social') return state(user);
    if (method === 'POST' && path === '/v1/presence') { run('UPDATE users SET seen=? WHERE id=?',now(),user.id); return state(user); }
    const data = await body(req);
    if(method==='POST' && path.startsWith('/v1/inventory/')){
      const action=path.slice('/v1/inventory/'.length);
      requireValue(['migrate','purchase','equip','earn','seen'].includes(action),404,'Unknown locker action.');
      inventory[action](user.id,data);return state(user);
    }
    if(method==='POST' && path==='/v1/matchmaking/join') {
      const party=membership(user.id);
      requireValue(party && party.host===user.id,403,'Only your party leader can find a match.');
      requireValue(!party.started && ['classic','hockey'].includes(party.mode),409,'Choose Online before finding a match.');
      const existing=userMatch(user.id);
      if(existing)return state(user);
      const members=all('SELECT u.* FROM users u JOIN members m ON m.user_id=u.id WHERE m.party_id=?',party.id);
      requireValue(!members.some(member=>userMatch(member.id)),409,'Your party is still in a match. Wait for them or leave the party.');
      requireValue(members.length<=(party.mode==='hockey'?5:7),409,'This party exceeds the team size for its sport.');
      requireValue(members.every(member=>member.seen>=now()-30),409,'Wait for everyone in your party to reconnect.');
      const version=String(data.version ?? '1.2.0');
      if(pool&&version===(party.mode==='hockey'?'1.6.1-hockey':'1.5.4')&&party.version!==version){run('UPDATE parties SET version=? WHERE id=?',version,party.id);party.version=version;}
      requireValue(version===party.version,409,'Everyone needs the same game update.');
      if(pool)requireValue(version===(party.mode==='hockey'?'1.6.1-hockey':'1.5.4'),409,'Install the dedicated-server game update before finding a match.');
      transaction(()=>{
        let game,team;
        for(const candidate of all("SELECT * FROM matches WHERE phase='searching' AND deadline>? AND version=? AND mode=? ORDER BY created,id",now()+5,version,party.mode)) {
          const counts={Red:0,Blue:0};
          for(const row of all('SELECT p.team,COUNT(*) AS n FROM match_members m JOIN match_parties p ON p.party_id=m.party_id WHERE m.match_id=? GROUP BY p.team',candidate.id))counts[row.team]=row.n;
          const choices=['Red','Blue'].sort((a,b)=>counts[a]-counts[b]);
          team=choices.find(side=>counts[side]+members.length<=(party.mode==='hockey'?5:7));
          if(team){game=candidate;break;}
        }
        if(!game) {
          game={id:id()};team='Red';
          run("INSERT INTO matches(id,host_party,phase,created,deadline,version) VALUES(?,?,'searching',?,?,?)",game.id,party.id,now(),now()+60,version);
          run('UPDATE matches SET mode=? WHERE id=?',party.mode,game.id);
          if(pool)run('UPDATE matches SET dedicated=1 WHERE id=?',game.id);
        }
        run('INSERT INTO match_parties VALUES(?,?,?)',party.id,game.id,team);
        for(const member of members)run('INSERT INTO match_members(user_id,match_id,party_id) VALUES(?,?,?)',member.id,game.id,party.id);
      });
      advanceMatches();return state(user);
    }
    if(method==='POST' && ['/v1/matchmaking/cancel','/v1/matchmaking/fail'].includes(path)) {
      const party=membership(user.id);requireValue(party,409,'Your party is no longer available.');
      requireValue(path.endsWith('/fail') || party.host===user.id,403,'Only your party leader can cancel matchmaking.');
      const game=userMatch(user.id);requireValue(path.endsWith('/fail') || !game || game.phase!=='playing',409,'Leave the match before finding another one.');
      if(game?.dedicated&&game.phase==='playing'){run('DELETE FROM match_members WHERE user_id=?',user.id);return state(user);}
      cancelGroup(party);return state(user);
    }
    if(method==='POST' && path==='/v1/matchmaking/route') {
      const game=userMatch(user.id),party=membership(user.id);
      requireValue(!game?.dedicated,403,'The dedicated match server publishes its own route.');
      requireValue(game && party && game.host_party===party.id && party.host===user.id,403,'Only the match host can publish this route.');
      requireValue(Number.isInteger(data.port)&&data.port>=1024&&data.port<=65535,400,'Invalid game port.');
      const lan=String(data.lan_ip ?? '');requireValue(!lan||isIP(lan),400,'Invalid local address.');
      run('UPDATE matches SET ip=?,lan_ip=?,port=? WHERE id=?',ipFor(req),lan,data.port,game.id);return state(user);
    }
    if(method==='POST' && path==='/v1/matchmaking/ready') {
      const game=userMatch(user.id);requireValue(game && ['searching','connecting'].includes(game.phase),409,'This match is no longer connecting.');
      run('UPDATE match_members SET ready=1 WHERE user_id=?',user.id);advanceMatches();return state(user);
    }
    if(method==='POST' && path==='/v1/matchmaking/start') {
      const game=userMatch(user.id),party=membership(user.id);
      requireValue(!game?.dedicated,403,'The dedicated match server starts the game.');
      requireValue(game && party && game.host_party===party.id && party.host===user.id,403,'Only the match host can start this match.');
      requireValue(game.phase==='selecting',409,'Wait for position selection.');
      run("UPDATE matches SET phase='playing' WHERE id=?",game.id);return state(user);
    }
    if (method === 'POST' && path === '/v1/friends/request') {
      const target = one('SELECT * FROM users WHERE username=?',normalize(data.username).replace(/^@/,''));
      requireValue(target,404,'No player has that username.');
      requireValue(target.id !== user.id,400,'That is your own username.');
      requireValue(!areFriends(user.id,target.id),409,'You are already friends.');
      requireValue(!one('SELECT 1 FROM requests WHERE sender=? AND receiver=?',target.id,user.id),409,`@${target.username} already sent you a request. Accept it in Requests.`);
      requireValue(!one('SELECT 1 FROM requests WHERE sender=? AND receiver=?',user.id,target.id),409,'You already sent this player a request.');
      requireValue(one('SELECT COUNT(*) AS n FROM requests WHERE sender=?',user.id).n < 50,429,'You have too many pending requests.');
      run('INSERT INTO requests VALUES(?,?,?)',id(),user.id,target.id); return state(user);
    }
    if(method==='POST' && path==='/v1/friends/cancel') {
      const request=one('SELECT * FROM requests WHERE id=?',String(data.request_id ?? ''));
      requireValue(request && request.sender===user.id,404,'Sent request was not found.');
      run('DELETE FROM requests WHERE id=?',request.id);return state(user);
    }
    if (method === 'POST' && ['/v1/friends/accept','/v1/friends/decline'].includes(path)) {
      const request = one('SELECT * FROM requests WHERE id=?',String(data.request_id ?? ''));
      requireValue(request && request.receiver === user.id,404,'Friend request was not found.');
      transaction(() => { if (path.endsWith('/accept')) run('INSERT OR IGNORE INTO friends VALUES(?,?)',...pair(request.sender,user.id)); run('DELETE FROM requests WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)',request.sender,user.id,user.id,request.sender); });
      return state(user);
    }
    if (method === 'POST' && path === '/v1/friends/remove') {
      const target = one('SELECT id FROM users WHERE username=?',normalize(data.username));
      requireValue(target,404,'Player was not found.');
      transaction(() => { run('DELETE FROM friends WHERE a=? AND b=?',...pair(user.id,target.id)); run('DELETE FROM invites WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)',user.id,target.id,target.id,user.id); });
      return state(user);
    }
    if (method === 'POST' && path === '/v1/parties/create') {
      requireValue(!membership(user.id),409,'Leave your current party first.');
      const mode = ['derby','hockey'].includes(data.mode) ? data.mode : 'classic';
      const partyId = id(), code = randomBytes(6).toString('hex').toUpperCase();
      transaction(() => { run('INSERT INTO parties(id,code,host,ip,mode,version) VALUES(?,?,?,?,?,?)',partyId,code,user.id,ipFor(req),mode,String(data.version ?? '1.1.0').slice(0,24)); run('INSERT INTO members VALUES(?,?)',user.id,partyId); run('UPDATE users SET seen=? WHERE id=?',now(),user.id); });
      return state(user);
    }
    if (method === 'POST' && path === '/v1/parties/route') {
      const party = membership(user.id); requireValue(party && party.host === user.id,403,'Only the party leader can publish the lobby.');
      requireValue(Number.isInteger(data.port) && data.port>=1024 && data.port<=65535,400,'Invalid game port.');
      const lan = String(data.lan_ip ?? ''); requireValue(!lan || isIP(lan),400,'Invalid local address.');
      run('UPDATE parties SET ip=?,lan_ip=?,port=?,started=?,public=?,mode=?,version=? WHERE id=?',ipFor(req),lan,data.port,data.started?1:0,data.public?1:0,data.mode === 'derby' ? 'derby':'classic',String(data.version ?? '1.1.0').slice(0,24),party.id);
      return state(user);
    }
    if (method === 'POST' && path === '/v1/parties/invite') {
      const party = membership(user.id), target = one('SELECT * FROM users WHERE username=?',normalize(data.username));
      requireValue(party && !party.started,409,'Create a party before inviting a friend.');
      requireValue(!one('SELECT 1 FROM match_parties WHERE party_id=?',party.id),409,'Cancel matchmaking before inviting another friend.');
      requireValue(target && areFriends(user.id,target.id),403,'You can invite accepted friends.');
      requireValue(!membership(target.id),409,'Your friend is already in a party.');
      run('INSERT OR IGNORE INTO invites VALUES(?,?,?,?)',id(),user.id,target.id,party.id); return state(user);
    }
    if (method === 'POST' && path === '/v1/parties/decline') { run('DELETE FROM invites WHERE id=? AND receiver=?',String(data.invite_id ?? ''),user.id); return state(user); }
    if (method === 'POST' && path === '/v1/parties/join') {
      const code = String(data.code ?? '').replace(/[\s-]/g,'').toUpperCase();
      const party = code ? one('SELECT * FROM parties WHERE code=?',code) : one('SELECT * FROM parties WHERE id=?',String(data.party_id ?? ''));
      requireValue(party,404,'That party is no longer available.');
      requireValue(!party.started,409,'That party is already playing.');
      requireValue(!one('SELECT 1 FROM match_parties WHERE party_id=?',party.id),409,'That party is finding or playing a match. Join them after this match.');
      const current = membership(user.id);
      requireValue(!current || current.id === party.id,409,'Leave your current party first.');
      const invited = one('SELECT 1 FROM invites WHERE receiver=? AND party_id=?',user.id,party.id);
      requireValue(code || invited || areFriends(user.id,party.host) || party.public,403,'Ask a friend for a party invitation.');
      transaction(() => {
        const count = one('SELECT COUNT(*) AS n FROM members WHERE party_id=?',party.id).n;
        requireValue(current || count < (party.mode === 'derby' ? 8:party.mode==='hockey'?5:7),409,'That party is full.');
        run('INSERT OR IGNORE INTO members VALUES(?,?)',user.id,party.id);
        run('DELETE FROM invites WHERE receiver=? AND party_id=?',user.id,party.id);
        run('UPDATE users SET seen=? WHERE id=?',now(),user.id);
      });
      return state(user);
    }
    if (method === 'POST' && path === '/v1/parties/leave') { leaveParty(user.id); return state(user); }
    if (method === 'POST' && path === '/v1/tickets') {
      const game=userMatch(user.id);
      if(game) {
        requireValue(['searching','connecting'].includes(game.phase)||(game.mode==='hockey'&&['selecting','playing'].includes(game.phase)),409,'This match is no longer accepting connections.');
        const proof=token();run('INSERT INTO match_tickets VALUES(?,?,?,?)',digest(proof),user.id,game.id,now()+45);
        return {ticket:proof,party_id:game.id};
      }
      const party = membership(user.id); requireValue(party,403,'Join a party first.');
      const proof = token(); run('INSERT INTO tickets VALUES(?,?,?,?)',digest(proof),user.id,party.id,now()+45);
      return { ticket:proof, party_id:party.id };
    }
    if (method === 'POST' && path === '/v1/tickets/verify') {
      const game=userMatch(user.id);
      if(game) {
        const proof=one('SELECT * FROM match_tickets WHERE hash=? AND expires>?',digest(String(data.ticket??'')),now());
        requireValue(['searching','connecting'].includes(game.phase)&&proof&&proof.match_id===game.id&&proof.user_id!==user.id&&userMatch(proof.user_id)?.id===game.id,403,'This player is not in your match.');
        run('DELETE FROM match_tickets WHERE hash=?',proof.hash);
        const leader=one('SELECT host FROM parties WHERE id=?',game.host_party);
        return {user:{...publicUser(one('SELECT * FROM users WHERE id=?',proof.user_id)),equipped:{...inventory.publicGear(proof.user_id),...cloud.gear(proof.user_id)}},party_id:game.id,host_id:leader.host};
      }
      const party = membership(user.id), proof = one('SELECT * FROM tickets WHERE hash=? AND expires>?',digest(String(data.ticket ?? '')),now());
      requireValue(party && proof && proof.party_id === party.id && proof.user_id !== user.id,403,'Could not verify this player.');
      requireValue(membership(proof.user_id)?.id === party.id,403,'This player left the party.');
      run('DELETE FROM tickets WHERE hash=?',proof.hash);
      return { user:{...publicUser(one('SELECT * FROM users WHERE id=?',proof.user_id)),equipped:{...inventory.publicGear(proof.user_id),...cloud.gear(proof.user_id)}}, party_id:party.id, host_id:party.host };
    }
    throw new ApiError(404,'This server does not support that feature.');
  }
  const server = http.createServer(async (req,res) => {
    const headers = { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' };
    try { const result = await route(req); res.writeHead(200,headers).end(JSON.stringify(result)); }
    catch(error) { const status = error.status ?? 500; if(status===500) console.error('Request failed:',error.message); res.writeHead(status,headers).end(JSON.stringify({ error: status===500 ? 'The server could not complete this request. Try again.':error.message })); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const maintenance=pool?setInterval(cleanup,1000):null;maintenance?.unref();
  return { server, db, pool, close: async () => { if(maintenance)clearInterval(maintenance);pool?.close();await new Promise(resolve => server.close(resolve));db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = createService({ database:process.env.DATABASE_PATH || './data/social.sqlite', trustProxy:process.env.TRUST_PROXY === '1', authConcurrency:Number(process.env.AUTH_CONCURRENCY || 6),dedicated:process.env.MLP_GAME_BINARY?{executable:process.env.MLP_GAME_BINARY,pack:process.env.MLP_GAME_PACK,address:process.env.MLP_GAME_ADDRESS,firstPort:Number(process.env.MLP_GAME_PORT||7002),capacity:Number(process.env.MLP_MATCH_CAPACITY||1)}:null });
  service.server.listen(Number(process.env.PORT || 8080),process.env.HOST || '0.0.0.0',() => console.log('MLP social service listening'));
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,async()=>{await service.close();process.exit(0);});
}
