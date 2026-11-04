import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createService } from './server.mjs';

test('three real Godot peers verify accounts, join during team selection, resist name spoofing and launch together', {timeout:65000}, async t=>{
  const service=createService({authLimit:100});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const password=randomBytes(24).toString('hex');
  const api=async(path,data,token)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
    assert.equal(response.status,200); return response.json();
  };
  const leader=await api('/v1/auth/register',{username:'leader_alpha',password});
  const joiner=await api('/v1/auth/register',{username:'joiner_beta',password});
  const late=await api('/v1/auth/register',{username:'late_teammate',password});
  await api('/v1/friends/request',{username:'joiner_beta'},leader.token);
  const request=(await api('/v1/presence',{},joiner.token)).incoming[0];
  await api('/v1/friends/accept',{request_id:request.id},joiner.token);
  await api('/v1/friends/request',{username:'late_teammate'},leader.token);
  const lateRequest=(await api('/v1/presence',{},late.token)).incoming[0];
  await api('/v1/friends/accept',{request_id:lateRequest.id},late.token);
  const socket=dgram.createSocket('udp4');
  await new Promise(r=>socket.bind(0,'127.0.0.1',r)); const port=socket.address().port; socket.close();
  const project=resolve('..');
  const executable=process.env.GODOT_BIN || 'C:/Users/joshg/Downloads/Godot_4.6.2_editor_repair/Godot_v4.6.2-stable_win64_console.exe';
  const runId=randomBytes(6).toString('hex');
  function peer(role) {
    const processHandle=spawn(executable,['--headless','--path',project,'--script','res://tools/social_peer_test.gd'],{
      cwd:project,windowsHide:true,
      env:{...process.env,APPDATA:join(project,'.godot',`social-${runId}-${role}`),MLP_SOCIAL_URL:base,MLP_TEST_ROLE:role,MLP_TEST_PORT:String(port),MLP_TEST_PASSWORD:password}
    });
    let output='';
    const watchers=[];
    const collect=data=>{output=(output+data.toString()).slice(-24000);for(const watcher of watchers)if(output.includes(watcher.text))watcher.resolve();};
    processHandle.stdout.on('data',collect);processHandle.stderr.on('data',collect);
    const exited=new Promise((resolve,reject)=>{processHandle.on('exit',code=>resolve(code));processHandle.on('error',reject);});
    t.after(()=>{if(processHandle.exitCode===null)processHandle.kill();});
    return { exited, output:()=>output, wait:async text=>{
      if(output.includes(text))return;
      await Promise.race([new Promise(resolve=>watchers.push({text,resolve})),exited.then(code=>{throw new Error(`Peer exited (${code}) before ${text}: ${output}`);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timeout waiting for ${text}: ${output}`)),45000);timer.unref();})]);
    }};
  }
  const host=peer('host');await host.wait('HOST_READY');
  const client=peer('client');
  await host.wait('HOST_PICKING_TEAMS');
  const lateClient=peer('late');
  await Promise.all([host.wait('HOST_MATCH_STARTED'),client.wait('CLIENT_VERIFIED_AND_PLAYING'),lateClient.wait('CLIENT_VERIFIED_AND_PLAYING')]);
  assert.equal(await client.exited,0,client.output());
  assert.equal(await lateClient.exited,0,lateClient.output());
  assert.equal(await host.exited,0,host.output());
  assert.doesNotMatch(host.output()+client.output()+lateClient.output(),/SCRIPT ERROR|Assertion failed/);
});

test('account gate, Friends, party creation and redesigned shop render correctly', {timeout:90000}, async t=>{
  let clock=Date.now();
  const socket=dgram.createSocket('udp4');await new Promise(r=>socket.bind(0,'127.0.0.1',r));const port=socket.address().port;socket.close();
  const project=resolve('..');
  const executable=process.env.GODOT_BIN || 'C:/Users/joshg/Downloads/Godot_4.6.2_editor_repair/Godot_v4.6.2-stable_win64_console.exe';
  const service=createService({authLimit:100,clock:()=>clock,dedicated:{executable,project,address:'127.0.0.1',firstPort:port,testEnv:{APPDATA:join(project,'.godot',`ui-worker-${randomBytes(6).toString('hex')}`)}}});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const password=randomBytes(24).toString('hex');
  const api=async(path,data,token)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
    assert.equal(response.status,200);return response.json();
  };
  const leader=await api('/v1/auth/register',{username:'leader_alpha',password});
  const friend=await api('/v1/auth/register',{username:'joiner_beta',password});
  const incoming=await api('/v1/auth/register',{username:'teammate_charlie',password});
  await api('/v1/friends/request',{username:'joiner_beta'},leader.token);
  const request=(await api('/v1/presence',{},friend.token)).incoming[0];
  await api('/v1/friends/accept',{request_id:request.id},friend.token);
  await api('/v1/friends/request',{username:'leader_alpha'},incoming.token);

  const child=spawn(executable,['--path',project,'--script','res://tools/preview_social.gd','--resolution','1440x900','--windowed','--audio-driver','Dummy'],{
    cwd:project,windowsHide:true,
    env:{...process.env,APPDATA:join(project,'.godot',`social-ui-${randomBytes(6).toString('hex')}`),MLP_SOCIAL_URL:base,MLP_TEST_ROLE:'preview',MLP_TEST_PORT:String(port),MLP_TEST_PASSWORD:password}
  });
  let output='',advanced=false;const collect=data=>{output=(output+data.toString()).slice(-24000);if(!advanced&&output.includes('UI_SEARCH_READY')){advanced=true;clock+=60000;}};child.stdout.on('data',collect);child.stderr.on('data',collect);
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  assert.equal(code,0,output);
  assert.match(output,/SOCIAL UI CHECKS PASSED/);
  assert.doesNotMatch(output,/SCRIPT ERROR|Assertion failed/);
});
