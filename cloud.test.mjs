import {DatabaseSync} from 'node:sqlite';
import {createCloud} from './cloud.mjs';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createService} from './server.mjs';
test('hockey cloud saves are account scoped, durable, bounded and use compare-and-swap',async t=>{
  const service=createService({authLimit:100});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const api=async(path,token,data)=>{const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,...await r.json()};};
  const a=await api('/v1/auth/register',null,{username:'cloud_alpha',password:'test-cloud-password'}),b=await api('/v1/auth/register',null,{username:'cloud_beta',password:'test-cloud-password'});
  assert.equal((await api('/v1/cloud/hockey')).status,401);
  const first=await api('/v1/cloud/hockey',a.token,{revision:0,document:{profile:'[cosmetics]\ncredits=160\n',career:'[league]\nstate={}\n'}});
  assert.equal(first.revision,1);
  assert.deepEqual((await api('/v1/cloud/hockey',b.token)).document,{});
  const clash=await api('/v1/cloud/hockey',a.token,{revision:0,document:{profile:'local'}});
  assert.equal(clash.conflict,true);assert.equal(clash.revision,1);assert.equal(clash.document.profile,first.document.profile);
  assert.equal((await api('/v1/cloud/hockey',a.token,{revision:1,document:{profile:'x'.repeat(600001)}})).status,400);
  assert.equal((await api('/v1/cloud/hockey',a.token,{revision:1,document:{unauthorized:'x'}})).status,400);
  const second=await api('/v1/cloud/hockey',a.token,{revision:1,document:{profile:'updated'}});
  assert.equal(second.revision,2);assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM hockey_cloud_history').get().n,2);
  assert.equal((await api('/v1/cloud/hockey',a.token)).document.profile,'updated');
});

test('new hockey collections replicate owned skins in the correct equipment slot',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('skin-user');");
 const cloud=createCloud(db,()=>123);
 const catalog=JSON.parse(readFileSync(new URL('./hockey_skin_catalog.json',import.meta.url),'utf8'));
 let revision=0;
 for(let i=0;i<24;i++){
  const helmet=catalog.helmet[i].id,stick=catalog.stick[i].id;
  const profile=`[cosmetics]\nowned=${JSON.stringify([helmet,stick])}\nhelmet=${JSON.stringify(helmet)}\nstick=${JSON.stringify(stick)}\n`;
  revision=cloud.write('skin-user',{revision,document:{profile}}).revision;
  assert.deepEqual(cloud.gear('skin-user'),{hockey_helmet:helmet,hockey_stick:stick});
 }
 const swapped=`[cosmetics]\nowned=${JSON.stringify([catalog.helmet[0].id,catalog.stick[0].id])}\nhelmet=${JSON.stringify(catalog.stick[0].id)}\nstick=${JSON.stringify(catalog.helmet[0].id)}\n`;
 cloud.write('skin-user',{revision,document:{profile:swapped}});
 assert.deepEqual(cloud.gear('skin-user'),{hockey_helmet:'helmet_hockey_original',hockey_stick:'hockey_stick_original'});
 db.close();
});
