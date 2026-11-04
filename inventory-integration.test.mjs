import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn}from'node:child_process';
import {resolve,join}from'node:path';
import {randomBytes}from'node:crypto';
import {createService}from'./server.mjs';
import {dailyOffers,catalog}from'./inventory.mjs';

test('real shop purchases follow an account to a fresh device and seven equipped party characters render',{timeout:240000},async t=>{
  const service=createService({authLimit:100});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`,password=randomBytes(24).toString('hex');
  const api=async(account,path,data={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{})},body:JSON.stringify(data)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;};
  const register=username=>api(null,'/v1/auth/register',{username,password});
  const captain=await register('cloud_captain');await register('separate_account');
  const party=(await api(captain,'/v1/parties/create',{version:'1.2.0'})).party,companions=[];
  const bats=catalog.filter(item=>item.type==='bat'&&item.price>0),helmets=catalog.filter(item=>item.type==='helmet'&&item.price>0);
  for(let i=0;i<6;i++){
    const friend=await register(`teammate_${i+1}`);companions.push(friend);
    await api(friend,'/v1/inventory/migrate',{legacy_id:randomBytes(16).toString('hex'),wallet:0,owned:[bats[i].id,helmets[i].id],equipped:{bat:bats[i].id,helmet:helmets[i].id},progress:{}});
    await api(friend,'/v1/parties/join',{code:party.code});
  }
  const heartbeat=setInterval(()=>{for(const friend of companions)api(friend,'/v1/presence').catch(()=>{});},10000);t.after(()=>clearInterval(heartbeat));
  const project=resolve('..'),runId=randomBytes(6).toString('hex');
  const executable=process.env.GODOT_BIN || 'C:/Users/joshg/Downloads/Godot_4.6.2_editor_repair/Godot_v4.6.2-stable_win64_console.exe';
  async function run(role,expected={}){
    const child=spawn(executable,['--path',project,'--script','res://tools/account_inventory_test.gd','--resolution','1440x900','--windowed','--audio-driver','Dummy'],{cwd:project,windowsHide:true,env:{...process.env,APPDATA:join(project,'.godot',`cloud-${runId}-${role}`),MLP_SOCIAL_URL:base,MLP_TEST_ROLE:role,MLP_TEST_PASSWORD:password,MLP_TEST_DAILY_IDS:JSON.stringify(dailyOffers().map(item=>item.id)),MLP_TEST_INVENTORY:JSON.stringify(expected)}});
    let output='';const collect=d=>{output=(output+d.toString()).slice(-30000);};child.stdout.on('data',collect);child.stderr.on('data',collect);t.after(()=>{if(child.exitCode===null)child.kill();});
    const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
    assert.equal(code,0,output);assert.match(output,/CLOUD LOCKER AND PARTY PASSED/);assert.doesNotMatch(output,/SCRIPT ERROR|Assertion failed/);
  }
  await run('cloud_first');
  if(process.env.MLP_SNAPSHOT_ONLY==='1')return;
  const expected=(await api(captain,'/v1/presence')).inventory;
  assert(expected.owned_bats.length>=4);assert(expected.owned_helmets.length>=3);assert(expected.owned_bats.includes('quest_bat_cage_rat'));
  await run('cloud_fresh',expected);
});
