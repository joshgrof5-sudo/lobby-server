import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from './server.mjs';

async function fixture(t, options={}) {
  const service=createService({authLimit:100,...options});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const api=async(path,data,access,method=data===undefined?'GET':'POST')=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(access?{Authorization:`Bearer ${access}`}:{})},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,...await response.json()};
  };
  const register=async name=>api('/v1/auth/register',{username:name,password:'a-long-test-password'});
  t.after(()=>service.close());
  return {...service,api,register};
}

test('small-server password hashing concurrency is bounded',async t=>{
  assert.throws(()=>createService({authConcurrency:0}),/AUTH_CONCURRENCY/);
  assert.throws(()=>createService({authConcurrency:NaN}),/AUTH_CONCURRENCY/);
  const {register}=await fixture(t,{authConcurrency:1});
  const responses=await Promise.all([register('first_player'),register('second_player')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,503]);
});

test('username ownership: case insensitive, race safe, password protected and session revocable',async t=>{
  const {api,register,db}=await fixture(t);
  const responses=await Promise.all([register('Slugger'),register('slugger')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const account=responses.find(r=>r.status===200);
  assert.equal(account.user.username,'slugger');
  assert.equal((await api('/v1/auth/login',{username:'SLUGGER',password:'wrong-password'})).status,401);
  const login=await api('/v1/auth/login',{username:'SLUGGER',password:'a-long-test-password'});
  assert.equal(login.user.id,account.user.id);
  assert.equal((await api('/v1/me',undefined,login.token)).user.username,'slugger');
  const stored=db.prepare('SELECT * FROM users').get();
  assert.notEqual(stored.password_hash,'a-long-test-password');
  assert.equal(stored.password_hash.length,128);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE hash=?').get(login.token).n,0);
  assert.equal((await api('/v1/auth/logout',{},login.token)).status,200);
  assert.equal((await api('/v1/me',undefined,login.token)).status,401);
  assert.equal((await register('not a username')).status,400);
  assert.equal((await api('/v1/auth/register',{username:'valid_name',password:'short'})).status,400);
});

test('friend requests, party invites, verified peer tickets and leader-only route updates',async t=>{
  const {api,register}=await fixture(t);
  const alice=await register('alice'),bob=await register('bob'),eve=await register('eve');
  assert.equal((await api('/v1/friends/request',{username:'bob'},alice.token)).status,200);
  assert.equal((await api('/v1/friends/request',{username:'BOB'},alice.token)).status,409);
  const request=(await api('/v1/social',undefined,bob.token)).incoming[0];
  assert.equal((await api('/v1/friends/accept',{request_id:request.id},eve.token)).status,404);
  assert.equal((await api('/v1/friends/accept',{request_id:request.id},bob.token)).friends[0].username,'alice');
  const created=await api('/v1/parties/create',{mode:'classic'},alice.token),party=created.party;
  assert.equal((await api('/v1/parties/join',{party_id:party.id},eve.token)).status,403);
  assert.equal((await api('/v1/parties/invite',{username:'bob'},alice.token)).status,200);
  assert.equal((await api('/v1/social',undefined,bob.token)).invites.length,1);
  const joined=await api('/v1/parties/join',{party_id:party.id},bob.token);
  assert.equal(joined.party.members.length,2);
  assert.equal(joined.invites.length,0);
  assert.equal((await api('/v1/parties/route',{port:7000,mode:'classic'},bob.token)).status,403);
  const route=await api('/v1/parties/route',{port:7000,mode:'classic',public:true,version:'1.1.0'},alice.token);
  assert.equal(route.party.ip,'127.0.0.1');
  const listing=await api('/lobbies?v=1.1.0');
  // Arrays remain compatible with the existing lobby list protocol.
  assert.equal(listing[0].name,'alice');
  const proof=await api('/v1/tickets',{},bob.token);
  assert.equal((await api('/v1/tickets/verify',{ticket:proof.ticket},eve.token)).status,403);
  const verified=await api('/v1/tickets/verify',{ticket:proof.ticket},alice.token);
  assert.equal(verified.user.username,'bob');
  assert.equal(verified.party_id,party.id);
  assert.equal((await api('/v1/tickets/verify',{ticket:proof.ticket},alice.token)).status,403);
  assert.equal((await api('/v1/tickets/verify',{ticket:'made-up-proof'},alice.token)).status,403);
  await api('/v1/parties/route',{port:7000,mode:'classic',started:true},alice.token);
  assert.equal((await api('/v1/parties/join',{code:party.code},eve.token)).status,409);
  await api('/v1/parties/leave',{},alice.token);
  assert.equal((await api('/v1/social',undefined,bob.token)).party,null);
});

test('friend request inboxes are private, recipients can decline, senders can cancel, and reciprocal requests stay clear',async t=>{
  const {api,register}=await fixture(t);
  const alice=await register('alice'),bob=await register('bob'),eve=await register('eve');
  assert.equal((await api('/v1/friends/request',{username:'alice'},alice.token)).status,400);
  assert.equal((await api('/v1/friends/request',{username:'nobody_here'},alice.token)).status,404);
  const sent=await api('/v1/friends/request',{username:' @BOB '},alice.token);
  assert.equal(sent.outgoing[0].username,'bob');assert.equal(sent.incoming.length,0);
  const inbox=await api('/v1/presence',{},bob.token),request=inbox.incoming[0];
  assert.equal(request.username,'alice');assert.equal(inbox.outgoing.length,0);
  assert.equal((await api('/v1/presence',{},eve.token)).incoming.length,0);
  assert.equal((await api('/v1/friends/decline',{request_id:request.id},eve.token)).status,404);
  assert.equal((await api('/v1/friends/accept',{request_id:request.id},alice.token)).status,404);
  assert.equal((await api('/v1/friends/cancel',{request_id:request.id},bob.token)).status,404);
  assert.equal((await api('/v1/friends/cancel',{request_id:request.id},eve.token)).status,404);
  const crossed=await api('/v1/friends/request',{username:'alice'},bob.token);
  assert.equal(crossed.status,409);assert.match(crossed.error,/Accept it in Requests/);
  assert.equal((await api('/v1/friends/decline',{request_id:request.id},bob.token)).incoming.length,0);
  assert.equal((await api('/v1/presence',{},alice.token)).outgoing.length,0);
  const resent=await api('/v1/friends/request',{username:'bob'},alice.token);
  assert.equal((await api('/v1/friends/cancel',{request_id:resent.outgoing[0].id},alice.token)).outgoing.length,0);
  assert.equal((await api('/v1/presence',{},bob.token)).incoming.length,0);
});

test('accepted friends update on both accounts, presence expires, and removing a friend clears both sides and invitations',async t=>{
  let time=Date.now();const {api,register}=await fixture(t,{clock:()=>time});
  const alice=await register('alice'),bob=await register('bob');
  const sent=await api('/v1/friends/request',{username:'bob'},alice.token);
  const accepted=await api('/v1/friends/accept',{request_id:sent.outgoing[0].id},bob.token);
  assert.equal(accepted.friends[0].username,'alice');assert.equal(accepted.incoming.length,0);
  const own=await api('/v1/presence',{},alice.token);assert.equal(own.friends[0].username,'bob');assert.equal(own.outgoing.length,0);assert.equal(own.friends[0].online,true);
  time+=61000;assert.equal((await api('/v1/presence',{},alice.token)).friends[0].online,false);
  await api('/v1/presence',{},bob.token);
  assert.equal((await api('/v1/presence',{},alice.token)).friends[0].online,true);
  await api('/v1/parties/create',{},alice.token);await api('/v1/parties/invite',{username:'bob'},alice.token);
  assert.equal((await api('/v1/presence',{},bob.token)).invites.length,1);
  const removed=await api('/v1/friends/remove',{username:'bob'},alice.token);
  assert.equal(removed.friends.length,0);assert.equal(removed.sent_invites.length,0);
  const other=await api('/v1/presence',{},bob.token);assert.equal(other.friends.length,0);assert.equal(other.invites.length,0);
  assert.equal((await api('/v1/parties/invite',{username:'bob'},alice.token)).status,403);
});

test('party code joining, capacity and offline cleanup',async t=>{
  let time=Date.now();
  const {api,register}=await fixture(t,{clock:()=>time});
  const host=await register('leader');
  const players=[];
  for(let i=0;i<9;i++) players.push(await register(`player_${i}`));
  const party=(await api('/v1/parties/create',{mode:'derby'},host.token)).party;
  const joins=await Promise.all(players.map(p=>api('/v1/parties/join',{code:party.code},p.token)));
  assert.equal(joins.filter(j=>j.status===200).length,7);
  assert.equal(joins.filter(j=>j.status===409).length,2);
  time+=76000;
  assert.equal((await api('/v1/social',undefined,host.token)).party,null);
});

test('ticket expiry, credentials persistence and expired session rejection',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mlp-social-'));
  const database=join(directory,'db.sqlite'); let time=Date.now();
  const first=createService({database,clock:()=>time});
  await new Promise(resolve=>first.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${first.server.address().port}`;
  const result=await fetch(url+'/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'persistent',password:'long-password-value'})}).then(r=>r.json());
  const friend=await fetch(url+'/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'saved_friend',password:'long-password-value'})}).then(r=>r.json());
  const sent=await fetch(url+'/v1/friends/request',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${result.token}`},body:JSON.stringify({username:'saved_friend'})}).then(r=>r.json());
  await first.close();
  const second=await fixture(t,{database,clock:()=>time});
  assert.equal((await second.api('/v1/me',undefined,result.token)).user.username,'persistent');
  const inbox=await second.api('/v1/presence',{},friend.token);
  assert.equal(inbox.incoming[0].id,sent.outgoing[0].id);assert.equal(inbox.incoming[0].username,'persistent');
  await second.api('/v1/friends/accept',{request_id:inbox.incoming[0].id},friend.token);
  assert.equal((await second.api('/v1/presence',{},result.token)).friends[0].username,'saved_friend');
  time+=31*86400000;
  assert.equal((await second.api('/v1/me',undefined,result.token)).status,401);
  t.after(()=>{for(const file of ['db.sqlite','db.sqlite-wal','db.sqlite-shm'])try{unlinkSync(join(directory,file));}catch(error){if(error.code!=='ENOENT')throw error;}rmdirSync(directory);});
});

test('authentication endpoints throttle repeated attempts',async t=>{
  const {register}=await fixture(t,{authLimit:1});
  assert.equal((await register('first')).status,200);
  assert.equal((await register('second')).status,429);
});
