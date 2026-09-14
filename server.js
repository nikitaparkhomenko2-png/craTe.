const http=require('http');const fs=require('fs');const path=require('path');const crypto=require('crypto');const WebSocket=require('ws');const {Pool}=require('pg');
const PORT=Number(process.env.PORT||3000),HOST='0.0.0.0',PUBLIC=path.join(__dirname,'public');
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false}):null;
if(pool) pool.on('error',e=>console.error('PostgreSQL pool error:',e));
let mem={users:[],messages:[],groups:[]};
async function init(){if(!pool){console.log('DATABASE_URL not set: using temporary memory store');return}await pool.query(`CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY,username text UNIQUE NOT NULL,display_name text NOT NULL,avatar text DEFAULT '',friends jsonb DEFAULT '[]',created_at bigint NOT NULL,password_hash text);CREATE TABLE IF NOT EXISTS messages(id text PRIMARY KEY,"from" text NOT NULL,"to" text NOT NULL,text text NOT NULL,time bigint NOT NULL);CREATE TABLE IF NOT EXISTS groups_data(id text PRIMARY KEY,name text NOT NULL,username text UNIQUE,avatar text DEFAULT '',owner text NOT NULL,members jsonb DEFAULT '[]',created_at bigint NOT NULL);ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;ALTER TABLE groups_data ADD COLUMN IF NOT EXISTS username text;ALTER TABLE groups_data ADD COLUMN IF NOT EXISTS avatar text DEFAULT '';CREATE UNIQUE INDEX IF NOT EXISTS groups_username_unique ON groups_data(username) WHERE username IS NOT NULL;`);console.log('Database ready')}
const clean=u=>({id:u.id,username:u.username,displayName:u.display_name||u.displayName||u.username,avatar:u.avatar||'',friends:Array.isArray(u.friends)?u.friends:[] ,createdAt:Number(u.created_at||u.createdAt||Date.now())});
async function users(){if(!pool)return mem.users;const r=await pool.query('SELECT * FROM users');return r.rows.map(clean)}
async function findUser(username){username=username.toLowerCase();if(!pool)return mem.users.find(u=>u.username===username);const r=await pool.query('SELECT * FROM users WHERE username=$1',[username]);return r.rows[0]&&clean(r.rows[0])}
function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(String(password),salt,64).toString('hex');return salt+':'+hash}
function verifyPassword(password,stored){if(!stored)return true;try{const [salt,hex]=String(stored).split(':');const a=Buffer.from(hex,'hex');const b=crypto.scryptSync(String(password),salt,a.length);return a.length===b.length&&crypto.timingSafeEqual(a,b)}catch{return false}}
async function createUser(username,password){const u={id:crypto.randomUUID(),username,displayName:username,avatar:'',friends:[],createdAt:Date.now(),passwordHash:hashPassword(password)};if(!pool){mem.users.push(u);return u}const r=await pool.query('INSERT INTO users(id,username,display_name,avatar,friends,created_at,password_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[u.id,u.username,u.displayName,u.avatar,JSON.stringify(u.friends),u.createdAt,u.passwordHash]);return clean(r.rows[0])}
async function updateFriends(username,friends){if(!pool){const u=mem.users.find(x=>x.username===username);if(u)u.friends=friends;return}await pool.query('UPDATE users SET friends=$1 WHERE username=$2',[JSON.stringify(friends),username])}
async function allMessages(){if(!pool)return mem.messages;const r=await pool.query('SELECT id,"from","to",text,time FROM messages ORDER BY time ASC');return r.rows.map(x=>({...x,time:Number(x.time)}))}
async function addMessage(m){if(!pool){mem.messages.push(m);return}await pool.query('INSERT INTO messages(id,"from","to",text,time) VALUES($1,$2,$3,$4,$5)',[m.id,m.from,m.to,m.text,m.time])}
async function allGroups(){if(!pool)return mem.groups;const r=await pool.query('SELECT * FROM groups_data ORDER BY created_at ASC');return r.rows.map(x=>({id:x.id,name:x.name,username:x.username||'',avatar:x.avatar||'',owner:x.owner,members:Array.isArray(x.members)?x.members:[],createdAt:Number(x.created_at)}))}
async function findGroup(id){if(!pool)return mem.groups.find(g=>g.id===id);const r=await pool.query('SELECT * FROM groups_data WHERE id=$1',[id]);const x=r.rows[0];return x&&{id:x.id,name:x.name,username:x.username||'',avatar:x.avatar||'',owner:x.owner,members:Array.isArray(x.members)?x.members:[],createdAt:Number(x.created_at)}}
async function findGroupByUsername(username){username=String(username).replace(/^@/,'').trim().toLowerCase();if(!pool)return mem.groups.find(g=>g.username===username);const r=await pool.query('SELECT * FROM groups_data WHERE username=$1',[username]);const x=r.rows[0];return x&&{id:x.id,name:x.name,username:x.username||'',avatar:x.avatar||'',owner:x.owner,members:Array.isArray(x.members)?x.members:[],createdAt:Number(x.created_at)}}
async function saveGroup(g){if(!pool){const i=mem.groups.findIndex(x=>x.id===g.id);if(i>=0)mem.groups[i]=g;return}await pool.query('UPDATE groups_data SET name=$1,username=$2,avatar=$3,members=$4 WHERE id=$5',[g.name,g.username||null,g.avatar||'',JSON.stringify(g.members||[]),g.id])}
async function deleteGroupData(id){if(!pool){mem.groups=mem.groups.filter(g=>g.id!==id);mem.messages=mem.messages.filter(m=>m.to!=='__group__'+id);return}await pool.query('DELETE FROM groups_data WHERE id=$1',[id]);await pool.query('DELETE FROM messages WHERE "to"=$1',['__group__'+id])}
async function deleteAccountData(username){if(!pool){mem.messages=mem.messages.filter(m=>m.from!==username&&m.to!==username);const owned=mem.groups.filter(g=>g.owner===username).map(g=>g.id);mem.groups=mem.groups.filter(g=>g.owner!==username);mem.groups.forEach(g=>g.members=(g.members||[]).filter(x=>x!==username));mem.users=mem.users.filter(u=>u.username!==username);return owned}const owned=(await pool.query('SELECT id FROM groups_data WHERE owner=$1',[username])).rows.map(x=>x.id);await pool.query('DELETE FROM messages WHERE "from"=$1 OR "to"=$1',[username]);await pool.query('DELETE FROM messages WHERE "to"=ANY($1)',[owned.map(id=>'__group__'+id)]);await pool.query('DELETE FROM groups_data WHERE owner=$1',[username]);await pool.query('UPDATE groups_data SET members=(SELECT jsonb_agg(x) FROM jsonb_array_elements(members) x WHERE x <> to_jsonb($1::text)) WHERE members @> to_jsonb(ARRAY[$1]::text[])',[username]);await pool.query("UPDATE users SET friends=COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(friends) x WHERE x <> to_jsonb($1::text)), '[]'::jsonb) WHERE friends @> to_jsonb(ARRAY[$1]::text[])",[username]);await pool.query('DELETE FROM users WHERE username=$1',[username]);return owned}
async function addGroup(g){if(!pool){mem.groups.push(g);return}await pool.query('INSERT INTO groups_data(id,name,username,avatar,owner,members,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[g.id,g.name,g.username||null,g.avatar||'',g.owner,JSON.stringify(g.members),g.createdAt])}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
function body(req){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e6){req.destroy();reject(new Error('too large'))}});req.on('end',()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}});req.on('error',reject)})}
async function ai(message){
  const prompt=String(message||'').trim();
  if(!prompt) return 'Напиши сообщение, и neXi AI ответит.';
  const url='https://text.pollinations.ai/'+encodeURIComponent(prompt)+'?model=openai&seed=42';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(url,{signal:controller.signal,headers:{'Accept':'text/plain'}});
    const text=(await r.text()).trim();
    if(!r.ok||!text) throw new Error('AI HTTP '+r.status);
    return text.slice(0,8000);
  }catch(e){
    console.error('AI error:',e.message);
    return 'neXi AI временно не отвечает. Попробуй ещё раз через несколько секунд.';
  }finally{clearTimeout(timer)}
}
const server=http.createServer(async(req,res)=>{try{
if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'});return res.end()}
if(req.url==='/api/health')return json(res,200,{ok:true,name:'craTe.'});
if(req.url.startsWith('/api/users/check/')){const username=decodeURIComponent(req.url.slice('/api/users/check/'.length)).replace(/^@/,'').trim().toLowerCase();const valid=/^[a-z0-9_.-]{3,24}$/.test(username);const exists=valid?!!(await findUser(username)):false;return json(res,200,{available:valid&&!exists,valid})}
if(req.url==='/api/register'&&req.method==='POST'){const b=await body(req),username=String(b.username||'').replace(/^@/,'').trim().toLowerCase(),password=String(b.password||'');if(!/^[a-z0-9_.-]{3,24}$/.test(username))return json(res,400,{error:'Username: 3–24 символа, только a-z, 0-9, _, ., -'});if(password.length<6)return json(res,400,{error:'Пароль минимум 6 символов'});if(await findUser(username))return json(res,409,{error:'Username уже занят'});return json(res,201,{user:clean(await createUser(username,password))})}
if(req.url==='/api/login'&&req.method==='POST'){const b=await body(req),username=String(b.username||'').replace(/^@/,'').trim().toLowerCase(),password=String(b.password||''),u=await findUser(username);if(!u)return json(res,404,{error:'Пользователь не найден'});let stored=null;if(pool){const rr=await pool.query('SELECT password_hash FROM users WHERE username=$1',[username]);stored=rr.rows[0]?.password_hash||null}else stored=u.passwordHash||null;if(!verifyPassword(password,stored))return json(res,401,{error:'Неверный пароль'});return json(res,200,{user:clean(u)})}
if(req.url.startsWith('/api/groups/search')&&req.method==='GET'){const q=new URL(req.url,'http://localhost').searchParams.get('username')||'';const g=await findGroupByUsername(q);return json(res,200,{group:g||null})}
if(req.url==='/api/users'&&req.method==='GET')return json(res,200,{users:await users()});
if(req.url==='/api/snapshot')return json(res,200,{users:await users(),messages:await allMessages(),groups:await allGroups()});
if(req.url==='/api/ai'&&req.method==='POST'){const b=await body(req),message=String(b.message||'').trim();if(!message)return json(res,400,{error:'Пустое сообщение'});return json(res,200,{reply:await ai(message)})}
let file=req.url==='/'?'/index.html':req.url.split('?')[0];const fp=path.normalize(path.join(PUBLIC,file));if(!fp.startsWith(PUBLIC))return json(res,403,{error:'forbidden'});return fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}const ext=path.extname(fp),ct={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.mp3':'audio/mpeg','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.otf':'font/otf','.ttf':'font/ttf'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':ct,'Cache-Control':'no-cache'});res.end(data)})
}catch(e){console.error('HTTP error:',e);if(!res.headersSent)json(res,500,{error:'Server error'})}});
const wss=new WebSocket.Server({server}),clients=new Map();
function sendTo(username,obj){for(const [ws,u] of clients)if(u.username===username&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function online(){return [...clients.values()].map(u=>u.username)}
async function snapshot(){return {users:await users(),messages:await allMessages(),groups:await allGroups()}}
wss.on('connection',ws=>{ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',async raw=>{try{const m=JSON.parse(raw);if(m.type==='ping')return;if(m.type==='hello'&&m.user){const real=await findUser(m.user.username);if(!real)return;ws.user=clean(real);clients.set(ws,ws.user);ws.send(JSON.stringify({type:'snapshot',...(await snapshot()),online:online()}));for(const [x] of clients)if(x!==ws&&x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'presence',username:ws.user.username,online:true}));return}if(!ws.user)return;
if(m.type==='add-friend'){const target=String(m.username||'').replace(/^@/,'').trim().toLowerCase();if(!target||target===ws.user.username)return;const other=await findUser(target);if(!other)return ws.send(JSON.stringify({type:'error',message:'Пользователь не найден'}));const me=await findUser(ws.user.username);const mf=[...(me.friends||[])],of=[...(other.friends||[])];if(!mf.includes(target))mf.push(target);if(!of.includes(me.username))of.push(me.username);await updateFriends(me.username,mf);await updateFriends(other.username,of);ws.user={...me,friends:mf};sendTo(me.username,{type:'friends',friends:mf});sendTo(target,{type:'friends',friends:of});return}
if(m.type==='message'){const to=String(m.to||'').replace(/^@/,'').trim().toLowerCase(),text=String(m.text||'').trim().slice(0,4000);if(!to||!text)return;const me=await findUser(ws.user.username);if(!(me.friends||[]).includes(to))return ws.send(JSON.stringify({type:'error',message:'Сначала добавь пользователя в друзья'}));const msg={id:crypto.randomUUID(),from:ws.user.username,to,text,time:Date.now()};await addMessage(msg);sendTo(to,{type:'message',message:msg});ws.send(JSON.stringify({type:'message',message:msg}));return}
if(m.type==='group-create'){
 const name=String(m.name||'').trim().slice(0,50),username=String(m.username||'').replace(/^@/,'').trim().toLowerCase(),avatar=String(m.avatar||'');
 if(!name)return ws.send(JSON.stringify({type:'error',message:'Введите название группы'}));
 if(!/^[a-z0-9_.-]{3,24}group$/.test(username))return ws.send(JSON.stringify({type:'error',message:'Юзер группы должен заканчиваться на group'}));
 if(await findGroupByUsername(username))return ws.send(JSON.stringify({type:'error',message:'Этот юзер группы уже занят'}));
 const g={id:crypto.randomUUID(),name,username,avatar,owner:ws.user.username,members:[ws.user.username],createdAt:Date.now()};await addGroup(g);ws.send(JSON.stringify({type:'group',group:g,created:true}));return
}
if(m.type==='group-join'){
 const g=await findGroup(m.id);if(!g)return ws.send(JSON.stringify({type:'error',message:'Группа не найдена'}));if(!(g.members||[]).includes(ws.user.username)){g.members=[...(g.members||[]),ws.user.username];await saveGroup(g)};ws.send(JSON.stringify({type:'group-joined',group:g}));return
}
if(m.type==='group-message'){
 const g=await findGroup(m.groupId);const text=String(m.text??'').trim();if(!g||!text)return;const msg={id:crypto.randomUUID(),from:ws.user.username,to:'__group__'+g.id,text,time:Date.now()};await addMessage(msg);for(const [x] of clients)if(x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'group-message',message:msg,groupId:g.id}));return
}
if(m.type==='group-delete'){
 const g=await findGroup(m.id);if(!g||g.owner!==ws.user.username)return ws.send(JSON.stringify({type:'error',message:'Удалить группу может только создатель'}));await deleteGroupData(g.id);for(const [x] of clients)if(x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'group-deleted',id:g.id}));return
}
if(m.type==='clear-chat'){
 const other=String(m.username||'').replace(/^@/,'').trim().toLowerCase();if(!other)return;if(!pool)mem.messages=mem.messages.filter(x=>!((x.from===ws.user.username&&x.to===other)||(x.from===other&&x.to===ws.user.username)));else await pool.query('DELETE FROM messages WHERE ("from"=$1 AND "to"=$2) OR ("from"=$2 AND "to"=$1)',[ws.user.username,other]);for(const [x] of clients)if(x.readyState===WebSocket.OPEN&&(x.user.username===ws.user.username||x.user.username===other))x.send(JSON.stringify({type:'chat-cleared',username:other}));return
}
if(m.type==='clear-group'){
 const id=String(m.groupId||'');const g=await findGroup(id);if(!g)return ws.send(JSON.stringify({type:'error',message:'Группа не найдена'}));if(!pool)mem.messages=mem.messages.filter(x=>x.to!=='__group__'+id);else await pool.query('DELETE FROM messages WHERE \"to\"=$1',['__group__'+id]);for(const [x] of clients)if(x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'group-chat-cleared',groupId:id}));return
}
if(m.type==='delete-account'){
 const username=ws.user.username;await deleteAccountData(username);for(const [x] of clients){if(x.user.username===username&&x.readyState===WebSocket.OPEN){x.send(JSON.stringify({type:'account-deleted',username}));setTimeout(()=>{try{x.close(4001,'account deleted')}catch{}},50)}else if(x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'account-removed',username}))}return
}
if(['call-offer','call-answer','ice','call-end'].includes(m.type)&&m.to)sendTo(String(m.to).replace(/^@/,'').toLowerCase(),{...m,from:ws.user.username});
}catch(e){console.error('WS error:',e);try{ws.send(JSON.stringify({type:'error',message:'Ошибка сервера'}))}catch{}}});ws.on('close',()=>{const u=clients.get(ws);clients.delete(ws);if(u)for(const [x] of clients)if(x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'presence',username:u.username,online:false}))})});
setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive)return ws.terminate();ws.isAlive=false;ws.ping()}},30000);
init().then(()=>server.listen(PORT,HOST,()=>console.log(`craTe. listening on ${PORT}`))).catch(e=>{console.error('Startup error',e);process.exit(1)});
