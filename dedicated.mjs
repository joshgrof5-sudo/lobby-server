import {spawn} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {existsSync} from 'node:fs';

// One OS process owns each match. No player is the transport authority.
export function createDedicatedPool(options,onExit,controlURL){
  const workers=new Map(),receipts=new Map();
  const capacity=options.capacity??1,firstPort=options.firstPort??7002;
  if(!Number.isInteger(capacity)||capacity<1||capacity>8||!Number.isInteger(firstPort)||firstPort<1024||firstPort+capacity-1>65535||(firstPort<=7777&&firstPort+capacity>7777))throw new Error('Invalid dedicated server capacity/ports.');
  if(!existsSync(options.executable)||!existsSync(options.pack??options.project))throw new Error('Dedicated game runtime/pack is missing.');
  let closing=false;
  const stop=id=>{const worker=workers.get(id);if(worker){workers.delete(id);worker.child.kill();}for(const [receipt,entry]of receipts)if(entry.match===id)receipts.delete(receipt);};
  return {
    workers,capacity,
    ensure(game){
      if(workers.has(game.id))return workers.get(game.id);
      if(workers.size>=capacity)return null;
      const used=new Set([...workers.values()].map(w=>w.port));
      let port=firstPort;while(used.has(port))port++;
      const key=randomBytes(32).toString('base64url');
      // The release runtime auto-loads its same-named PCK and bootstrap scene.
      // --main-pack is only needed by editor binaries used in integration tests.
      const args=['--headless','--audio-driver','Dummy',...(options.pack?(options.packWithEditor?['--main-pack',options.pack]:[]):['--path',options.project,'--script','res://dedicated_match.gd'])];
      const child=(options.spawnProcess??spawn)(options.executable,args,{windowsHide:true,env:{...process.env,MLP_DEDICATED:'1',MLP_MATCH_ID:game.id,MLP_MATCH_MODE:game.mode??'classic',MLP_MATCH_PORT:String(port),MLP_WORKER_KEY:key,MLP_MATCH_CONTROL_URL:controlURL(),...(options.testEnv??{})},stdio:['ignore','pipe','pipe']});
      const worker={child,key,port,ready:false,seen:Date.now(),started:Date.now()};workers.set(game.id,worker);
      // Game logs contain no account passwords, session tokens or worker keys.
      for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{if(options.log)options.log(String(data));});
      const exited=()=>{if(workers.get(game.id)!==worker)return;workers.delete(game.id);if(!closing)onExit(game.id);};
      child.once('exit',exited);child.once('error',exited);
      return worker;
    },
    authenticate(id,key){const w=workers.get(id);return w&&typeof key==='string'&&/^[A-Za-z0-9_-]{43}$/.test(key)&&timingSafeEqual(Buffer.from(key),Buffer.from(w.key))?w:null;},
    issueReceipt(match,user){const value=randomBytes(32).toString('base64url');receipts.set(value,{match,user,expires:Date.now()+30000});return value;},
    consumeReceipt(value,match,user){const entry=receipts.get(value);if(!entry||entry.match!==match||entry.user!==user||entry.expires<Date.now())return false;receipts.delete(value);return true;},
    sweep(active){for(const [id,w]of workers)if(!active.has(id)||Date.now()-w.seen>45000||Date.now()-w.started>2*60*60*1000){stop(id);if(active.has(id)&&!closing)onExit(id);}for(const [key,r]of receipts)if(r.expires<Date.now())receipts.delete(key);},
    stop,
    close(){closing=true;for(const id of [...workers.keys()])stop(id);}
  };
}
