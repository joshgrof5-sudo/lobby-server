import {randomInt} from 'node:crypto';
const sports=['baseball','hockey','football'];
const fields=['wins','losses','scores','seconds'];
const empty=()=>Object.fromEntries(sports.map(s=>[s,Object.fromEntries(fields.map(k=>[k,0]))]));
export function createProfiles(db,clock,chooseSport=()=>randomInt(3)){
  db.exec(`CREATE TABLE IF NOT EXISTS player_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,avatar_sport TEXT NOT NULL,football_helmet TEXT NOT NULL DEFAULT 'helmet_football_rookie',totals TEXT NOT NULL,seeded INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS player_profile_events(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,event_id TEXT NOT NULL,PRIMARY KEY(user_id,event_id));`);
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  const read=user=>{
    let row=db.prepare('SELECT * FROM player_profiles WHERE user_id=?').get(user);
    if(!row){db.prepare('INSERT OR IGNORE INTO player_profiles(user_id,avatar_sport,totals,updated) VALUES(?,?,?,?)').run(user,sports[chooseSport()],JSON.stringify(empty()),clock());row=db.prepare('SELECT * FROM player_profiles WHERE user_id=?').get(user);}
    return {...row,totals:JSON.parse(row.totals)};
  };
  const update=(user,data)=>{
    if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'Invalid profile update.');
    const events=data.events??[];
    if(!Array.isArray(events)||events.length>100)fail(400,'Invalid profile events.');
    for(const e of events){if(!e||typeof e.id!=='string'||!/^[a-zA-Z0-9:_.-]{1,128}$/.test(e.id)||!sports.includes(e.sport)||!fields.includes(e.kind)||!Number.isSafeInteger(e.amount)||e.amount===0||Math.abs(e.amount)>(e.kind==='seconds'?600:e.kind==='scores'?100:1)||(e.kind==='seconds'&&e.amount<0))fail(400,'Invalid profile event.');}
    if(data.seed!==undefined){if(!data.seed||typeof data.seed!=='object'||Array.isArray(data.seed))fail(400,'Invalid profile seed.');for(const sport of sports)for(const key of fields){const n=data.seed[sport]?.[key]??0;if(!Number.isSafeInteger(n)||n<0||n>315360000)fail(400,'Invalid profile seed.');}}
    if(data.football_helmet!==undefined&&(typeof data.football_helmet!=='string'||!/^helmet_football_[a-z0-9_]{1,64}$/.test(data.football_helmet)))fail(400,'Invalid portrait helmet.');
    read(user);
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=read(user);let seeded=row.seeded;
      if(!seeded&&data.seed){for(const sport of sports)for(const key of fields)row.totals[sport][key]=data.seed[sport]?.[key]??0;seeded=1;}
      for(const e of events){const inserted=db.prepare('INSERT OR IGNORE INTO player_profile_events VALUES(?,?)').run(user,e.id);if(inserted.changes)row.totals[e.sport][e.kind]=Math.max(0,row.totals[e.sport][e.kind]+e.amount);}
      db.prepare('UPDATE player_profiles SET totals=?,seeded=?,football_helmet=?,updated=? WHERE user_id=?').run(JSON.stringify(row.totals),seeded,data.football_helmet??row.football_helmet,clock(),user);
      db.exec('COMMIT');return read(user);
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  };
  return {read,update};
}
