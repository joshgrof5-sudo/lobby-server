import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import dgram from 'node:dgram';
import {createService} from './server.mjs';

test('dedicated Godot owns the match and continues when its party captain leaves',{timeout:130000},async t=>{
  let clock=Date.now(),logs='';const trace=[];
  const project=resolve('..'),run=randomBytes(5).toString('hex');
  const controlFile=join(project,'.godot',`live-controls-${run}`);
  t.after(()=>{rmSync(controlFile,{force:true});rmSync(controlFile+'.grab',{force:true});});
  const executable=process.env.GODOT_BIN||'C:/Users/joshg/Downloads/Godot_4.6.2_editor_repair/Godot_v4.6.2-stable_win64_console.exe';
  const socket=dgram.createSocket('udp4');await new Promise(r=>socket.bind(0,'127.0.0.1',r));const port=socket.address().port;socket.close();
  const service=createService({authLimit:100,clock:()=>clock,dedicated:{executable:process.env.MLP_TEST_GAME_BINARY||executable,project,...(process.env.MLP_TEST_GAME_PACK?{pack:resolve(process.env.MLP_TEST_GAME_PACK),packWithEditor:!process.env.MLP_TEST_GAME_BINARY}:{}),address:'127.0.0.1',firstPort:port,log:s=>logs=(logs+s).slice(-35000),testEnv:{APPDATA:join(project,'.godot',`dedi-${run}-server`)}}});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  let memberCount=-1;
  service.server.on('request',(req,res)=>{trace.push(req.url);if(trace.length>400)trace.shift();res.once('finish',()=>{const count=service.db.prepare('SELECT COUNT(*) AS n FROM match_members').get().n;if(count!==memberCount){memberCount=count;console.log('MATCH ROSTER',req.url,count);}});});
  const base=`http://127.0.0.1:${service.server.address().port}`,password=randomBytes(24).toString('hex');
  const api=async(account,path,data={},status=200)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{})},body:JSON.stringify(data)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;};
  const captain=await api(null,'/v1/auth/register',{username:'server_captain',password}),friend=await api(null,'/v1/auth/register',{username:'server_friend',password});
  const party=(await api(captain,'/v1/parties/create',{version:'1.4.5'})).party;await api(friend,'/v1/parties/join',{code:party.code});
  await api(captain,'/v1/matchmaking/join',{version:'1.4.5'});
  // Put this party on the fielding side so both humans can interact at once.
  service.db.prepare("UPDATE match_parties SET team='Blue'").run();
  await api(captain,'/v1/matchmaking/route',{port:port+1},403);
  await api(null,'/internal/match',{match_id:'bad',action:'state'},403);
  function client(role){
    const child=spawn(executable,['--headless','--path',project,'--script','res://tools/dedicated_peer_test.gd'],{windowsHide:true,env:{...process.env,APPDATA:join(project,'.godot',`dedi-${run}-${role}`),MLP_TEST_INTERACTIONS:'1',MLP_TEST_CONTROL_FILE:controlFile,MLP_SOCIAL_URL:base,MLP_TEST_ROLE:role,MLP_TEST_PASSWORD:password}});
    let output='';const watchers=[];child.stdout.on('data',collect);child.stderr.on('data',collect);function collect(data){output=(output+data).slice(-35000);for(const w of watchers)if(output.includes(w.text))w.resolve();}
    const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});t.after(()=>{if(child.exitCode===null)child.kill();});
    return{output:()=>output,exited,wait:async text=>{if(output.includes(text))return;await Promise.race([new Promise(resolve=>watchers.push({text,resolve})),exited.then(code=>{throw new Error(`${role} exited ${code} before ${text}: ${output}\nWORKER: ${logs}\nAPI: ${trace.join(',')}`);}),new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(new Error(`${text} timed out: ${output}\nWORKER: ${logs}`)),100000);timeout.unref();})]);}};
  }
  const leader=client('server_captain'),member=client('server_friend');
  await Promise.all([leader.wait('DEDICATED_ACCOUNT_READY_'),member.wait('DEDICATED_ACCOUNT_READY_')]);
  clock+=60000;await api(friend,'/v1/presence');
  await Promise.all([leader.wait('LIVE_CONTROL_READY'),member.wait('LIVE_CONTROL_READY')]);
  writeFileSync(controlFile,'ready');
  await Promise.all([leader.wait('LIVE_GRAB_READY'),member.wait('LIVE_GRAB_READY')]);
  writeFileSync(controlFile+'.grab','ready');
  await Promise.all([leader.wait('DEDICATED_GAME_PLAYING_'),member.wait('DEDICATED_GAME_PLAYING_')]);
  await leader.wait('DEDICATED_CAPTAIN_LEFT');await member.wait('DEDICATED_SURVIVED_CAPTAIN_LEAVING');
  for(const client of [leader,member]){assert.equal(await client.exited,0,client.output());assert.doesNotMatch(client.output(),/SCRIPT ERROR|Assertion failed/);}
  const samples=client=>new Map([...client.output().matchAll(/BOT_POSE_SAMPLE \S+ (\d+) (\d+)/g)].map(match=>[match[1],match[2]]));
  const first=samples(leader),second=samples(member),common=[...first.keys()].filter(frame=>second.has(frame));
  assert(common.length>=3,'Clients did not observe enough shared authoritative pose frames');
  for(const frame of common)assert.equal(first.get(frame),second.get(frame),'Party leader and member received different full-body poses');
  for(const client of [leader,member])assert.match(client.output(),/BOT_PITCH_POSE_VERIFIED_/);
  for(const client of [leader,member])assert.match(client.output(),/HUMAN_POSE_RELAY_VERIFIED_/);
  for(const client of [leader,member]){assert.match(client.output(),/LIVE_PUNCH_OBSERVED_/);assert.match(client.output(),/LIVE_THROW_OBSERVED_/);}
  for(const client of [leader,member])assert.match(client.output(),/LIVE_WEIGHTED_GRIP_VERIFIED_/);
  assert.match(logs,/DEDICATED MATCH PLAYING/);assert.doesNotMatch(logs,/SCRIPT ERROR|Assertion failed/);
  const state=await api(friend,'/v1/presence');assert.equal(state.match.phase,'playing');assert.equal(state.party.host_id,friend.user.id);assert.equal(service.pool.workers.size,1);
});
