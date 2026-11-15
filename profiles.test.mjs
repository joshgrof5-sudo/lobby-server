import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProfiles} from './profiles.mjs';
import {createService} from './server.mjs';
function store(t){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES(\'a\'),(\'b\'),(\'c\');');t.after(()=>db.close());let choice=0;return {db,profiles:createProfiles(db,()=>123,()=>choice++%3)};}
test('portrait sport is chosen once per account from all three sports',t=>{
  const {profiles}=store(t);
  assert.deepEqual(['a','b','c'].map(id=>profiles.read(id).avatar_sport),['baseball','hockey','football']);
  for(let i=0;i<5;i++)assert.equal(profiles.read('a').avatar_sport,'baseball');
});
test('profile event retries, multiple devices, corrections and legacy imports count once',t=>{
  const {profiles}=store(t);
  const seed={hockey:{wins:3,losses:2,scores:8,seconds:600}};
  const events=[{id:'device-a:win',sport:'football',kind:'wins',amount:1},{id:'device-a:td',sport:'football',kind:'scores',amount:2},{id:'time:a',sport:'baseball',kind:'seconds',amount:60}];
  profiles.update('a',{seed,events,football_helmet:'helmet_football_rookie'});
  profiles.update('a',{seed:{hockey:{wins:999}},events});
  profiles.update('a',{events:[{id:'device-b:win',sport:'football',kind:'wins',amount:1},{id:'rewind:td',sport:'football',kind:'scores',amount:-1}]});
  const result=profiles.read('a').totals;
  assert.equal(result.hockey.wins,3);assert.equal(result.football.wins,2);assert.equal(result.football.scores,1);assert.equal(result.baseball.seconds,60);
  assert.equal(Object.values(result).reduce((n,s)=>n+s.seconds,0),660);
  assert.equal(profiles.read('b').totals.football.wins,0);
});
test('invalid profile batches cannot partly apply or accept arbitrary portrait paths',t=>{
  const {profiles}=store(t);
  assert.throws(()=>profiles.update('a',{events:[{id:'good',sport:'hockey',kind:'wins',amount:1},{id:'bad',sport:'hockey',kind:'seconds',amount:9999999}]}),/Invalid/);
  assert.equal(profiles.read('a').totals.hockey.wins,0);
  assert.throws(()=>profiles.update('a',{football_helmet:'https://example.com/avatar'}),/Invalid/);
  assert.throws(()=>profiles.update('a',{seed:{baseball:{wins:-1}}}),/Invalid/);
});
test('only accepted friends or the owner can read a player profile; removing friendship revokes access',async t=>{
  const service=createService({authLimit:100});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  assert.equal((await (await fetch(base+'/health')).json()).player_profiles,true);
  const api=async(account,path,data={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{})},body:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
  const a=(await api(null,'/v1/auth/register',{username:'profile_alice',password:'profile-test-password'})).data;
  const b=(await api(null,'/v1/auth/register',{username:'profile_bob',password:'profile-test-password'})).data;
  assert.equal((await api(null,'/v1/profiles/read',{user_id:a.user.id})).status,401);
  assert.equal((await api(b,'/v1/profiles/read',{user_id:a.user.id})).status,403);
  await api(a,'/v1/profiles/update',{events:[{id:'goal',sport:'hockey',kind:'scores',amount:1}]});
  await api(a,'/v1/friends/request',{username:b.user.username});
  const request=(await api(b,'/v1/presence')).data.incoming[0];await api(b,'/v1/friends/accept',{request_id:request.id});
  const viewed=await api(b,'/v1/profiles/read',{user_id:a.user.id});
  assert.equal(viewed.status,200);assert.equal(viewed.data.stats.hockey.scores,1);assert.equal(viewed.data.username,'profile_alice');
  assert(!JSON.stringify(viewed.data).includes('password_hash'));
  const friends=(await api(b,'/v1/presence')).data.friends;assert.equal(friends[0].profile.avatar_sport,viewed.data.avatar_sport);
  await api(b,'/v1/friends/remove',{username:a.user.username});
  assert.equal((await api(b,'/v1/profiles/read',{user_id:a.user.id})).status,403);
});
