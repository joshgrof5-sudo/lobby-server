import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createService} from './server.mjs';

test('two real game UIs receive requests automatically, accept, invite, join and remove friends without leaking accounts',{timeout:80000},async t=>{
  const service=createService({authLimit:100});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`,password=randomBytes(24).toString('hex');
  for(const username of ['request_sender','request_receiver','clean_account']){
    const response=await fetch(base+'/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);
  }
  const project=resolve('..'),runId=randomBytes(6).toString('hex');
  const executable=process.env.GODOT_BIN || 'C:/Users/joshg/Downloads/Godot_4.6.2_editor_repair/Godot_v4.6.2-stable_win64_console.exe';
  function peer(role){
    const args=['--path',project,'--script','res://tools/friends_peer_test.gd','--audio-driver','Dummy'];
    if(role==='friends_sender')args.unshift('--headless');else args.push('--resolution','1440x900','--windowed');
    const child=spawn(executable,args,{cwd:project,windowsHide:true,env:{...process.env,APPDATA:join(project,'.godot',`friends-${runId}-${role}`),MLP_SOCIAL_URL:base,MLP_TEST_ROLE:role,MLP_TEST_PASSWORD:password}});
    let output='';const watchers=[];const collect=data=>{output=(output+data.toString()).slice(-28000);for(const w of watchers)if(output.includes(w.text))w.resolve();};child.stdout.on('data',collect);child.stderr.on('data',collect);
    const exited=new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    return {exited,output:()=>output,wait:async text=>{
      if(output.includes(text))return;
      await Promise.race([new Promise(resolve=>watchers.push({text,resolve})),exited.then(code=>{throw new Error(`${role} exited (${code}) before ${text}: ${output}`);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`${role} timed out: ${output}`)),60000);timer.unref();})]);
    }};
  }
  const receiver=peer('friends_receiver');await receiver.wait('RECIPIENT_READY');
  const sender=peer('friends_sender');
  await Promise.all([receiver.wait('LIVE FRIENDS UI PASSED'),sender.wait('LIVE FRIENDS UI PASSED')]);
  for(const peer of [receiver,sender]){assert.equal(await peer.exited,0,peer.output());assert.doesNotMatch(peer.output(),/SCRIPT ERROR|Assertion failed/);}
});
