import {readFileSync} from 'node:fs';
const hockeySkins=JSON.parse(readFileSync(new URL('./hockey_skin_catalog.json',import.meta.url),'utf8'));
const legacyFinishes=['original','arctic','redline','blackice','aurora','copper','checker','glacier','champion','sunset'];
const validHockeyGear=Object.fromEntries(['helmet','stick'].map(slot=>[slot,new Set([...legacyFinishes.map(id=>(slot==='helmet'?'helmet_hockey_':'hockey_stick_')+id),...hockeySkins[slot].map(item=>item.id)])]));
export function createCloud(db,clock){
  db.exec(`CREATE TABLE IF NOT EXISTS hockey_cloud(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL, document TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hockey_cloud_history(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL, document TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(user_id,revision));`);
  const read=user=>{const row=db.prepare('SELECT * FROM hockey_cloud WHERE user_id=?').get(user);return {revision:row?.revision??0,document:row?JSON.parse(row.document):{},updated:row?.updated??0};};
  const error=(status,message)=>{throw Object.assign(new Error(message),{status});};
  const write=(user,data)=>{
    if(!Number.isSafeInteger(data.revision)||data.revision<0)error(400,'Invalid cloud revision.');
    const document=data.document;
    if(!document||typeof document!=='object'||Array.isArray(document)||Object.keys(document).some(key=>!['profile','season','career'].includes(key)))error(400,'Invalid hockey save.');
    for(const value of Object.values(document))if(typeof value!=='string'||Buffer.byteLength(value)>600000)error(400,'Invalid hockey save size.');
    const encoded=JSON.stringify(document);if(Buffer.byteLength(encoded)>1800000)error(413,'Hockey save is too large.');
    db.exec('BEGIN IMMEDIATE');
    try{
      const current=read(user);
      if(current.revision!==data.revision){db.exec('ROLLBACK');return {...current,conflict:true};}
      const revision=current.revision+1,updated=clock();
      db.prepare('INSERT OR REPLACE INTO hockey_cloud VALUES(?,?,?,?)').run(user,revision,encoded,updated);
      db.prepare('INSERT INTO hockey_cloud_history VALUES(?,?,?,?)').run(user,revision,encoded,updated);
      db.prepare('DELETE FROM hockey_cloud_history WHERE user_id=? AND revision<=?').run(user,revision-10);
      db.exec('COMMIT');return {revision,updated,document};
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  };
  const gear=user=>{
    const result={hockey_helmet:'helmet_hockey_original',hockey_stick:'hockey_stick_original'};
    const profile=String(read(user).document.profile??'');let section='';const values={};
    for(const line of profile.split(/\r?\n/)){
      const trimmed=line.trim();if(trimmed.startsWith('[')){section=trimmed;continue;}
      if(section!=='[cosmetics]')continue;
      const match=trimmed.match(/^(owned|helmet|stick)\s*=\s*(.*)$/);if(!match)continue;
      try{values[match[1]]=JSON.parse(match[2]);}catch{}
    }
    const owned=new Set(['helmet_hockey_original','hockey_stick_original','helmet_hockey_arctic','hockey_stick_arctic',...(Array.isArray(values.owned)?values.owned:[])]);
    for(const slot of ['helmet','stick'])if(typeof values[slot]==='string'&&owned.has(values[slot])&&validHockeyGear[slot].has(values[slot]))result['hockey_'+slot]=values[slot];
    return result;
  };
  return {read,write,gear};
}
