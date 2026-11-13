import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const catalog=JSON.parse(readFileSync(new URL('./equipment_catalog.json',import.meta.url),'utf8'));
const items=new Map(catalog.map(item=>[item.id,item]));
items.set('classic',{id:'classic',type:'bat',price:0,event:'',goal:0});
const events=new Set(catalog.filter(item=>item.event).map(item=>item.event));
events.add('derby_wins');
function check(value,message,status=400){if(!value)throw Object.assign(new Error(message),{status});}
export function dailyOffers(time=Date.now()){
  const day=Math.floor(time/86400000);
  return ['bat','helmet'].flatMap(type=>catalog.filter(item=>item.type===type&&item.price>0&&!item.event)
    .map(item=>({item,rank:createHash('sha256').update(`mlp-daily-v2|${day}|${type}|${item.id}`).digest('hex')}))
    .sort((a,b)=>a.rank<b.rank?-1:a.rank>b.rank?1:a.item.id.localeCompare(b.item.id)).slice(0,4).map(entry=>entry.item));
}

export function createInventory(db,clock=Date.now){
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_inventory(user_id TEXT PRIMARY KEY REFERENCES users(id),initialized INTEGER NOT NULL DEFAULT 0,wallet INTEGER NOT NULL DEFAULT 0,bat TEXT NOT NULL DEFAULT 'classic',helmet TEXT NOT NULL DEFAULT 'helmet_classic',revision INTEGER NOT NULL DEFAULT 0,new_ids TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS inventory_items(user_id TEXT NOT NULL REFERENCES users(id),item_id TEXT NOT NULL,PRIMARY KEY(user_id,item_id));
    CREATE TABLE IF NOT EXISTS inventory_progress(user_id TEXT NOT NULL REFERENCES users(id),event TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(user_id,event));
    CREATE TABLE IF NOT EXISTS inventory_events(user_id TEXT NOT NULL REFERENCES users(id),event_id TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
    CREATE TABLE IF NOT EXISTS inventory_legacy(legacy_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id));
  `);
  const run=(sql,...args)=>db.prepare(sql).run(...args),one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args);
  const ensure=user=>{const existing=one('SELECT * FROM account_inventory WHERE user_id=?',user);if(existing)return existing;run('INSERT OR IGNORE INTO account_inventory(user_id) VALUES(?)',user);return one('SELECT * FROM account_inventory WHERE user_id=?',user);};
  const has=(user,item)=>['classic','helmet_classic'].includes(item)||!!one('SELECT 1 FROM inventory_items WHERE user_id=? AND item_id=?',user,item);
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const bump=user=>run('UPDATE account_inventory SET revision=revision+1 WHERE user_id=?',user);
  const view=user=>{
    const profile=ensure(user),owned=all('SELECT item_id FROM inventory_items WHERE user_id=? ORDER BY item_id',user).map(row=>row.item_id);
    return {initialized:!!profile.initialized,revision:profile.revision,wallet:profile.wallet,owned_bats:['classic',...owned.filter(id=>items.get(id)?.type==='bat')],owned_helmets:['helmet_classic',...owned.filter(id=>items.get(id)?.type==='helmet')],equipped:{bat:profile.bat,helmet:profile.helmet},quests:{progress:Object.fromEntries(all('SELECT event,value FROM inventory_progress WHERE user_id=?',user).map(row=>[row.event,row.value])),new_ids:JSON.parse(profile.new_ids)}};
  };
  const publicGear=user=>{const profile=ensure(user);return {bat:profile.bat,helmet:profile.helmet,jersey:parseInt(user.slice(0,4),16)%99+1};};
  const migrate=(user,data)=>transaction(()=>{
    if(ensure(user).initialized)return view(user);
    check(/^[A-Za-z0-9_-]{16,80}$/.test(String(data.legacy_id??'')),'Could not identify the old equipment save.');
    const claimed=one('SELECT user_id FROM inventory_legacy WHERE legacy_id=?',data.legacy_id);
    // Each old save can belong to only one account. A second account starts fresh.
    if(!claimed){
      run('INSERT INTO inventory_legacy VALUES(?,?)',data.legacy_id,user);
      check(Number.isInteger(data.wallet)&&data.wallet>=0&&data.wallet<=10000000,'Invalid old Club Cash balance.');
      run('UPDATE account_inventory SET wallet=? WHERE user_id=?',data.wallet,user);
      check(Array.isArray(data.owned)&&data.owned.length<=100,'Invalid old equipment list.');
      for(const id of data.owned){if(items.has(id)&&!['classic','helmet_classic'].includes(id))run('INSERT OR IGNORE INTO inventory_items VALUES(?,?)',user,id);}
      for(const [event,value]of Object.entries(data.progress??{}))if(events.has(event)&&Number.isInteger(value)&&value>=0&&value<=1000000)run('INSERT INTO inventory_progress VALUES(?,?,?)',user,event,value);
      const bat=String(data.equipped?.bat??'classic'),helmet=String(data.equipped?.helmet??'helmet_classic');
      run('UPDATE account_inventory SET bat=?,helmet=? WHERE user_id=?',has(user,bat)&&items.get(bat)?.type==='bat'?bat:'classic',has(user,helmet)&&items.get(helmet)?.type==='helmet'?helmet:'helmet_classic',user);
    }
    run('UPDATE account_inventory SET initialized=1 WHERE user_id=?',user);bump(user);return view(user);
  });
  const requireReady=user=>check(ensure(user).initialized,'Wait for your account locker to finish loading.',409);
  const purchase=(user,data)=>transaction(()=>{
    requireReady(user);const item=items.get(String(data.item_id??''));
    check(item&&item.price>0&&!item.event,'This item cannot be bought.');
    if(has(user,item.id))return view(user);
    check(data.day===Math.floor(clock()/86400000)&&dailyOffers(clock()).some(offer=>offer.id===item.id),"The shop refreshed. Check today's items.",409);
    check(ensure(user).wallet>=item.price,'Not enough Club Cash.',409);
    run('UPDATE account_inventory SET wallet=wallet-? WHERE user_id=?',item.price,user);
    run('INSERT INTO inventory_items VALUES(?,?)',user,item.id);
    run(`UPDATE account_inventory SET ${item.type==='bat'?'bat':'helmet'}=? WHERE user_id=?`,item.id,user);
    const fresh=JSON.parse(ensure(user).new_ids);fresh.push(item.id);run('UPDATE account_inventory SET new_ids=? WHERE user_id=?',JSON.stringify(fresh),user);
    bump(user);return view(user);
  });
  const equip=(user,data)=>transaction(()=>{
    requireReady(user);const item=items.get(String(data.item_id??''));check(item&&has(user,item.id),'You do not own that item.',403);
    run(`UPDATE account_inventory SET ${item.type==='bat'?'bat':'helmet'}=? WHERE user_id=?`,item.id,user);bump(user);return view(user);
  });
  const earn=(user,data)=>transaction(()=>{
    requireReady(user);check(Array.isArray(data.events)&&data.events.length<=32,'Invalid reward batch.');
    for(const event of data.events){
      check(typeof event.id==='string'&&event.id.length>=8&&event.id.length<=200,'Invalid reward ID.');
      check(event.kind==='cash'||events.has(event.kind),'Unknown reward type.');
      check(Number.isInteger(event.amount)&&event.amount>0&&event.amount<=(event.kind==='cash'?10000:1000),'Invalid reward amount.');
      if(one('SELECT 1 FROM inventory_events WHERE user_id=? AND event_id=?',user,event.id))continue;
      run('INSERT INTO inventory_events VALUES(?,?)',user,event.id);
      if(event.kind==='cash')run('UPDATE account_inventory SET wallet=MIN(1000000000,wallet+?) WHERE user_id=?',event.amount,user);
      else run('INSERT INTO inventory_progress VALUES(?,?,?) ON CONFLICT(user_id,event) DO UPDATE SET value=MIN(1000000,value+excluded.value)',user,event.kind,event.amount);
    }
    const progress=Object.fromEntries(all('SELECT event,value FROM inventory_progress WHERE user_id=?',user).map(row=>[row.event,row.value]));
    const fresh=JSON.parse(ensure(user).new_ids);
    for(const item of catalog)if(item.event&&(progress[item.event]??0)>=item.goal&&!has(user,item.id)){run('INSERT INTO inventory_items VALUES(?,?)',user,item.id);fresh.push(item.id);}
    run('UPDATE account_inventory SET new_ids=? WHERE user_id=?',JSON.stringify(fresh),user);bump(user);return view(user);
  });
  const seen=(user,data)=>{requireReady(user);run('UPDATE account_inventory SET new_ids=? WHERE user_id=?',JSON.stringify(JSON.parse(ensure(user).new_ids).filter(id=>id!==data.item_id)),user);bump(user);};
  return {view,publicGear,migrate,purchase,equip,earn,seen};
}
