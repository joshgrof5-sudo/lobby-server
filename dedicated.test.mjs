import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createService} from './server.mjs';

async function fixture(t){
  let time=Date.now();const children=[];
  const service=createService({authLimit:100,clock:()=>time,dedicated:{executable:process.execPath,project:process.cwd(),address:'127.0.0.1',firstPort:7002,spawnProcess:(_file,_args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.env=options.env;child.kill=()=>child.emit('exit',0);children.push(child);return child;}}});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const api=async(account,path,data={},expected=200,extra={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{...extra})},body:JSON.stringify(data)});const d=await r.json();assert.equal(r.status,expected,JSON.stringify(d));return d;};
  const register=username=>api(null,'/v1/auth/register',{username,password:'dedicated-test-password'});
  const captain=await register('dedicated_captain'),friend=await register('dedicated_friend');
  const party=(await api(captain,'/v1/parties/create',{version:'1.4.8'})).party;await api(friend,'/v1/parties/join',{code:party.code});
  const match=(await api(captain,'/v1/matchmaking/join',{version:'1.4.8'})).match;
  time+=60000;await api(captain,'/v1/presence');assert.equal(children.length,1);
  const child=children[0];
  const worker=(action,data={},expected=200,key=child.env.MLP_WORKER_KEY)=>api(null,'/internal/match',{action,match_id:match.id,...data},expected,{'X-MLP-Worker':key});
  await worker('listening');
  async function playing(){for(const account of [captain,friend])await api(account,'/v1/matchmaking/ready');await worker('start');}
  return {api,worker,register,playing,captain,friend,match,service,child,advance:seconds=>{time+=seconds*1000;}};
}

test('dedicated identity uses one-use account-bound receipts, and clients cannot publish or start matches',async t=>{
  const f=await fixture(t);
  assert.equal(f.match.dedicated,true);assert.equal(f.match.host_id,'dedicated');
  await f.api(f.captain,'/v1/matchmaking/route',{port:7003},403);
  await f.api(f.captain,'/v1/matchmaking/start',{},403);
  await f.worker('state',{},403,'invalid');
  const ticket=(await f.api(f.friend,'/v1/tickets')).ticket;
  const proof=await f.worker('verify',{ticket});
  assert.equal(proof.user.id,f.friend.user.id);
  await f.worker('verify',{ticket},403);
  await f.api(f.captain,'/v1/dedicated/verify-server',{receipt:proof.receipt},403);
  assert.equal((await f.api(f.friend,'/v1/dedicated/verify-server',{receipt:proof.receipt})).verified,true);
  await f.api(f.friend,'/v1/dedicated/verify-server',{receipt:proof.receipt},403);
});

test('a party captain leaving does not end a dedicated match and the remaining friend becomes party leader',async t=>{
  const f=await fixture(t);await f.playing();
  await f.api(f.captain,'/v1/parties/leave');
  const state=await f.api(f.friend,'/v1/presence');
  assert.equal(state.match.id,f.match.id);assert.equal(state.match.phase,'playing');
  assert.equal(state.match.members.length,1);assert.equal(state.party.host_id,f.friend.user.id);
  assert.equal(f.service.pool.workers.size,1);
});

test('one disconnected party member does not remove their connected friends; worker failure returns parties safely',async t=>{
  const f=await fixture(t);await f.playing();
  await f.api(f.captain,'/v1/matchmaking/fail');
  const state=await f.api(f.friend,'/v1/presence');assert.equal(state.match.members.length,1);assert.equal(state.match.id,f.match.id);
  await f.api(f.captain,'/v1/matchmaking/join',{version:'1.4.8'},409);
  await f.api(f.captain,'/v1/parties/leave');
  assert.equal((await f.api(f.friend,'/v1/presence')).match.id,f.match.id);
  f.child.emit('exit',1);
  const after=await f.api(f.friend,'/v1/presence');assert.equal(after.match,null);assert.equal(after.party.members.length,1);assert.equal(f.service.pool.workers.size,0);
});

test('one-slot dedicated capacity queues another match and frees the slot after completion',async t=>{
  const f=await fixture(t);await f.playing();
  const waiting=await f.register('waiting_player');await f.api(waiting,'/v1/parties/create',{version:'1.4.8'});
  const next=(await f.api(waiting,'/v1/matchmaking/join',{version:'1.4.8'})).match;
  await f.api(f.captain,'/v1/presence');await f.api(f.friend,'/v1/presence');
  f.advance(60);
  const queued=(await f.api(waiting,'/v1/presence')).match;
  assert.equal(queued.phase,'searching');assert.equal(queued.port,0);assert.equal(f.service.pool.workers.size,1);
  await f.worker('finish');await f.api(waiting,'/v1/presence');
  const connecting=(await f.api(waiting,'/v1/presence')).match;
  assert.equal(connecting.id,next.id);assert.equal(connecting.phase,'connecting');assert.equal(f.service.pool.workers.size,1);
});

test('an existing party can use the new game patch without losing its members',async t=>{
  const f=await fixture(t);
  await f.worker('finish');
  f.service.db.prepare('UPDATE parties SET version=?').run('1.3.0');
  await f.api(f.friend,'/v1/presence');
  const updated=await f.api(f.captain,'/v1/matchmaking/join',{version:'1.4.8'});
  assert.equal(updated.party.version,'1.4.8');
  assert.equal(updated.party.members.length,2);
  assert.equal(updated.match.members.length,2);
});
