import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from './server.mjs';

async function fixture(t) {
  let time=Date.now();
  const service=createService({clock:()=>time,authLimit:100});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const api=async(token,path,data={})=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
    return {status:response.status,...await response.json()};
  };
  let n=0;
  const player=async()=>{const result=await api(null,'/v1/auth/register',{username:`player_${++n}`,password:'test-match-password'});assert.equal(result.status,200);return result;};
  const party=async(size=1)=>{
    const members=[];for(let i=0;i<size;i++)members.push(await player());
    const host=members[0];const state=await api(host.token,'/v1/parties/create',{version:'1.2.0'});assert.equal(state.status,200);
    for(const member of members.slice(1))assert.equal((await api(member.token,'/v1/parties/join',{code:state.party.code})).status,200);
    return {host,members,id:state.party.id,code:state.party.code};
  };
  const queue=group=>api(group.host.token,'/v1/matchmaking/join',{version:'1.2.0'});
  return {...service,api,player,party,queue,advance:seconds=>{time+=seconds*1000;}};
}

test('parties match together, verified tickets cross parties, 60 second search then position selection',async t=>{
  const f=await fixture(t),a=await f.party(2),b=await f.party();
  assert.equal((await f.api(a.members[1].token,'/v1/matchmaking/join',{version:'1.2.0'})).status,403);
  const first=await f.queue(a),second=await f.queue(b);
  assert.equal(first.match.remaining,60);assert.equal(second.match.id,first.match.id);
  assert.deepEqual(second.match.members.filter(m=>m.party_id===a.id).map(m=>m.team),['Red','Red']);
  assert.equal(second.match.members.find(m=>m.party_id===b.id).team,'Blue');
  assert.equal((await f.api(b.host.token,'/v1/matchmaking/route',{port:18082})).status,403);
  assert.equal((await f.api(a.host.token,'/v1/matchmaking/route',{port:18082})).status,200);
  const ticket=await f.api(b.host.token,'/v1/tickets');
  assert.equal(ticket.party_id,first.match.id);
  const verified=await f.api(a.host.token,'/v1/tickets/verify',{ticket:ticket.ticket});
  assert.equal(verified.user.id,b.host.user.id);assert.equal(verified.host_id,a.host.user.id);
  assert.equal((await f.api(a.host.token,'/v1/tickets/verify',{ticket:ticket.ticket})).status,403);
  for(const member of [...a.members,...b.members])assert.equal((await f.api(member.token,'/v1/matchmaking/ready')).status,200);
  f.advance(59);assert.equal((await f.api(a.host.token,'/v1/presence')).match.phase,'searching');
  f.advance(1);const selected=await f.api(a.host.token,'/v1/presence');
  assert.equal(selected.match.phase,'selecting');assert.equal(selected.match.selection_remaining,30);assert.equal(selected.match.bots,11);
  assert.equal((await f.api(b.host.token,'/v1/matchmaking/start')).status,403);
  assert.equal((await f.api(a.host.token,'/v1/matchmaking/start')).match.phase,'playing');
});

test('cancellation keeps original parties and party leader cannot split a group across matches',async t=>{
  const f=await fixture(t),a=await f.party(2),b=await f.party();
  const first=await f.queue(a);await f.queue(b);
  assert.equal((await f.api(a.members[1].token,'/v1/matchmaking/cancel')).status,403);
  assert.equal((await f.queue(a)).match.id,first.match.id);
  assert.equal((await f.api(b.host.token,'/v1/matchmaking/cancel')).match,null);
  assert.equal((await f.api(a.host.token,'/v1/presence')).match.members.length,2);
  await f.queue(b);
  const cancelled=await f.api(a.host.token,'/v1/matchmaking/cancel');
  assert.equal(cancelled.match,null);assert.equal(cancelled.party.id,a.id);assert.equal(cancelled.party.members.length,2);
  const other=await f.api(b.host.token,'/v1/presence');assert.equal(other.match,null);assert.equal(other.party.id,b.id);
  const outsider=await f.player();await f.queue(a);
  assert.equal((await f.api(outsider.token,'/v1/parties/join',{code:a.code})).status,409);
});

test('full matches begin connecting early; groups stay within seven positions per team',async t=>{
  const f=await fixture(t),a=await f.party(7),b=await f.party(7);
  const first=await f.queue(a),full=await f.queue(b);
  assert.equal(full.match.id,first.match.id);assert.equal(full.match.phase,'connecting');assert.equal(full.match.bots,0);
  assert.equal(full.match.members.filter(m=>m.team==='Red').length,7);assert.equal(full.match.members.filter(m=>m.team==='Blue').length,7);
  const extra=await f.party();assert.notEqual((await f.queue(extra)).match.id,first.match.id);
});

test('connection grace removes an incomplete party as a whole and fills its positions with bots',async t=>{
  const f=await fixture(t),a=await f.party(2),b=await f.party(2);
  await f.queue(a);await f.queue(b);
  for(const member of a.members)await f.api(member.token,'/v1/matchmaking/ready');
  await f.api(b.host.token,'/v1/matchmaking/ready');
  f.advance(60);assert.equal((await f.api(a.host.token,'/v1/presence')).match.phase,'connecting');
  f.advance(15);const locked=await f.api(a.host.token,'/v1/presence');
  assert.equal(locked.match.phase,'selecting');assert.equal(locked.match.members.length,2);assert.equal(locked.match.bots,12);
  const excluded=await f.api(b.host.token,'/v1/presence');assert.equal(excluded.match,null);assert.equal(excluded.party.members.length,2);
});
