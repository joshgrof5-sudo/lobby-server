import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,rmdirSync}from'node:fs';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {randomBytes}from'node:crypto';
import {createService}from'./server.mjs';
import {dailyOffers,catalog}from'./inventory.mjs';

async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'mlp-inventory-')),database=join(directory,'account.sqlite');
  let service,base,time=Date.now();
  const start=async()=>{service=createService({database,authLimit:100,clock:()=>time});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${service.server.address().port}`;};await start();
  t.after(async()=>{await service.close();for(const file of ['account.sqlite','account.sqlite-wal','account.sqlite-shm'])try{unlinkSync(join(directory,file));}catch(error){if(error.code!=='ENOENT')throw error;}rmdirSync(directory);});
  const api=async(account,path,data={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{})},body:JSON.stringify(data)});return {status:r.status,...await r.json()};};
  const register=async username=>{const result=await api(null,'/v1/auth/register',{username,password:'test-inventory-password'});assert.equal(result.status,200);return result;};
  const initialize=(account,overrides={})=>api(account,'/v1/inventory/migrate',{legacy_id:randomBytes(16).toString('hex'),owned:[],wallet:50000,equipped:{bat:'classic',helmet:'helmet_classic'},progress:{},...overrides});
  return {api,register,initialize,day:()=>Math.floor(time/86400000),offers:()=>dailyOffers(time),advance:seconds=>{time+=seconds*1000;},restart:async()=>{await service.close();await start();}};
}

test('legacy gear transfers once to one account and cannot leak into another account on the same computer',async t=>{
  const f=await fixture(t),alice=await f.register('alice'),bob=await f.register('bob'),legacy=randomBytes(16).toString('hex');
  const first=await f.initialize(alice,{legacy_id:legacy,owned:['chrome','helmet_cherry_bomb'],equipped:{bat:'chrome',helmet:'helmet_cherry_bomb'}});
  assert.equal(first.inventory.initialized,true);assert(first.inventory.owned_bats.includes('chrome'));assert.equal(first.inventory.equipped.helmet,'helmet_cherry_bomb');
  const repeat=await f.initialize(alice,{wallet:999999,owned:['gold']});assert.equal(repeat.inventory.wallet,50000);assert(!repeat.inventory.owned_bats.includes('gold'));
  const second=await f.initialize(bob,{legacy_id:legacy,owned:['chrome'],wallet:50000});
  assert.deepEqual(second.inventory.owned_bats,['classic']);assert.equal(second.inventory.wallet,0);assert.equal(second.inventory.equipped.bat,'classic');
});

test('account shop uses authoritative UTC offers, server prices, one charge and owned-only equips',async t=>{
  const f=await fixture(t),alice=await f.register('alice');await f.initialize(alice);
  const offer=f.offers()[0],day=f.day();
  const results=await Promise.all([1,2].map(()=>f.api(alice,'/v1/inventory/purchase',{item_id:offer.id,day,price:0})));
  assert(results.every(r=>r.status===200));
  const state=await f.api(alice,'/v1/presence');assert.equal(state.inventory.wallet,50000-offer.price);assert.equal(state.inventory.equipped.bat,offer.id);
  assert.equal(state.inventory.owned_bats.filter(id=>id===offer.id).length,1);
  const outside=catalog.find(item=>item.type==='bat'&&item.price>0&&!item.event&&!f.offers().some(offer=>offer.id===item.id));
  assert.equal((await f.api(alice,'/v1/inventory/purchase',{item_id:outside.id,day})).status,409);
  assert.equal((await f.api(alice,'/v1/inventory/equip',{item_id:outside.id})).status,403);
  const helmet=f.offers()[4];assert.equal((await f.api(alice,'/v1/inventory/purchase',{item_id:helmet.id,day:day-1})).status,409);
  assert.equal((await f.api(alice,'/v1/inventory/purchase',{item_id:helmet.id,day})).inventory.equipped.helmet,helmet.id);
  assert.equal((await f.api(alice,'/v1/inventory/equip',{item_id:'classic'})).inventory.equipped.bat,'classic');
});

test('reward retries do not duplicate cash or quest rewards, and invalid batches roll back',async t=>{
  const f=await fixture(t),alice=await f.register('alice');await f.initialize(alice,{wallet:0});
  const events=[{id:'unique-cash-award',kind:'cash',amount:750},{id:'unique-quest-progress',kind:'practice_hits',amount:100}];
  for(let n=0;n<2;n++)assert.equal((await f.api(alice,'/v1/inventory/earn',{events})).status,200);
  let state=await f.api(alice,'/v1/presence');assert.equal(state.inventory.wallet,750);assert.equal(state.inventory.quests.progress.practice_hits,100);
  assert(state.inventory.owned_bats.includes('quest_bat_cage_rat'));assert(state.inventory.owned_helmets.includes('quest_helmet_fastball_flash'));
  assert.equal((await f.api(alice,'/v1/inventory/earn',{events:[{id:'atomic-test-good',kind:'cash',amount:100},{id:'atomic-test-invalid',kind:'cash',amount:-1}]})).status,400);
  state=await f.api(alice,'/v1/presence');assert.equal(state.inventory.wallet,750);
  await f.api(alice,'/v1/inventory/seen',{item_id:'quest_bat_cage_rat'});
  assert(!(await f.api(alice,'/v1/presence')).inventory.quests.new_ids.includes('quest_bat_cage_rat'));
});

test('a fresh session and server restart load the same locker, cash, quest progress and equipped bat/helmet',async t=>{
  const f=await fixture(t),alice=await f.register('alice');await f.initialize(alice,{owned:['gold','helmet_nebula'],equipped:{bat:'gold',helmet:'helmet_nebula'}});
  const before=(await f.api(alice,'/v1/presence')).inventory;await f.restart();
  const login=await f.api(null,'/v1/auth/login',{username:'alice',password:'test-inventory-password'});assert.equal(login.status,200);
  assert.deepEqual((await f.api(login,'/v1/presence')).inventory,before);
});

test('party members expose equipped gear, never another account locker, and cap at seven characters',async t=>{
  const f=await fixture(t),alice=await f.register('alice');await f.initialize(alice,{owned:['gold','helmet_nebula'],equipped:{bat:'gold',helmet:'helmet_nebula'}});
  const party=(await f.api(alice,'/v1/parties/create',{version:'1.2.0'})).party;
  for(let i=0;i<6;i++){const friend=await f.register(`friend_${i}`);await f.initialize(friend,{wallet:0});const joined=await f.api(friend,'/v1/parties/join',{code:party.code});assert.equal(joined.status,200);const leader=joined.party.members.find(member=>member.id===alice.user.id);assert.equal(leader.equipped.bat,'gold');assert.equal(leader.equipped.helmet,'helmet_nebula');assert.equal(leader.inventory,undefined);assert.equal(leader.owned_bats,undefined);}
  assert.equal((await f.api(alice,'/v1/presence')).party.members.length,7);
  const eighth=await f.register('eighth_player');assert.equal((await f.api(eighth,'/v1/parties/join',{code:party.code})).status,409);
});
