const http=require('http');const fs=require('fs');const path=require('path');const crypto=require('crypto');const WebSocket=require('ws');const {Pool}=require('pg');
const PORT=Number(process.env.PORT||3000),HOST='0.0.0.0',PUBLIC=path.join(__dirname,'public');
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false}):null;
if(pool) pool.on('error',e=>console.error('PostgreSQL pool error:',e));
let mem={users:[],messages:[],groups:[]};
async function init(){if(!pool){console.log('DATABASE_URL not set: using temporary memory store');return}await pool.query(`CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY,username text UNIQUE NOT NULL,display_name text NOT NULL,avatar text DEFAULT '',friends jsonb DEFAULT '[]',created_at bigint NOT NULL);CREATE TABLE IF NOT EXISTS messages(id text PRIMARY KEY,"from" text NOT NULL,"to" text NOT NULL,text text NOT NULL,time bigint NOT NULL);CREATE TABLE IF NOT EXISTS groups_data(id text PRIMARY KEY,name text NOT NULL,owner text NOT NULL,members jsonb DEFAULT '[]',created_at bigint NOT NULL);`);console.log('Database ready')}
const clean=u=>({id:u.id,username:u.username,displayName:u.display_name||u.displayName||u.username,avatar:u.avatar||'',friends:Array.isArray(u.friends)?u.friends:[] ,createdAt:Number(u.created_at||u.createdAt||Date.now())});
async function users(){if(!pool)return mem.users;const r=await pool.query('SELECT * FROM users');return r.rows.map(clean)}
async function findUser(username){username=username.toLowerCase();if(!pool)return mem.users.find(u=>u.username===username);const r=await pool.query('SELECT * FROM users WHERE username=$1',[username]);return r.rows[0]&&clean(r.rows[0])}
async function createUser(username){const u={id:crypto.randomUUID(),username,displayName:username,avatar:'',friends:[],createdAt:Date.now()};if(!pool){mem.users.push(u);return u}const r=await pool.query('INSERT INTO users(id,username,display_name,avatar,friends,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[u.id,u.username,u.displayName,u.avatar,JSON.stringify(u.friends),u.createdAt]);return clean(r.rows[0])}
async function updateFriends(username,friends){if(!pool){const u=mem.users.find(x=>x.username===username);if(u)u.friends=friends;return}await pool.query('UPDATE users SET friends=$1 WHERE username=$2',[JSON.stringify(friends),username])}
async function allMessages(){if(!pool)return mem.messages;const r=await pool.query('SELECT id,"from","to",text,time FROM messages ORDER BY time ASC');return r.rows.map(x=>({...x,time:Number(x.time)}))}
async function addMessage(m){if(!pool){mem.messages.push(m);return}await pool.query('INSERT INTO messages(id,"from","to",text,time) VALUES($1,$2,$3,$4,$5)',[m.id,m.from,m.to,m.text,m.time])}
async function allGroups(){if(!pool)return mem.groups;const r=await pool.query('SELECT * FROM groups_data ORDER BY created_at ASC');return r.rows.map(x=>({id:x.id,name:x.name,owner:x.owner,members:x.members,createdAt:Number(x.created_at)}))}
async function addGroup(g){if(!pool){mem.groups.push(g);return}await pool.query('INSERT INTO groups_data(id,name,owner,members,created_at) VALUES($1,$2,$3,$4,$5)',[g.id,g.name,g.owner,JSON.stringify(g.members),g.createdAt])}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
function body(req){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e6){req.destroy();reject(new Error('too large'))}});req.on('end',()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}});req.on('error',reject)})}
async function ai(message){
  const prompt=String(message||'').trim();
  if(!prompt)return 'Напиши сообщение, и neXi AI ответит.';
  const url='https://text.pollinations.ai/'+encodeURIComponent(prompt)+'?model=openai&seed=42';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(url,{signal:controller.signal,headers:{'Accept':'text/plain'}});
    const text=(await r.text()).trim();
    if(!r.ok||!text)throw new Error('AI HTTP '+r.status);
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
if(req.url==='/api/register'&&req.method==='POST'){const b=await body(req),username=String(b.username||'').replace(/^@/,'').trim().toLowerCase();if(!/^[a-z0-9_.-]{3,24}$/.test(username))return json(res,400,{error:'Username: 3–24 символа, только a-z, 0-9, _, ., -'});if(await findUser(username))return json(res,409,{error:'Username уже занят'});return json(res,201,{user:clean(await createUser(username))})}
if(req.url==='/api/login'&&req.method==='POST'){const b=await body(req),username=String(b.username||'').replace(/^@/,'').trim().toLowerCase(),u=await findUser(username);if(!u)return json(res,404,{error:'Пользователь не найден'});return json(res,200,{user:clean(u)})}
if(req.url==='/api/users'&&req.method==='GET')return json(res,200,{users:await users()});
if(req.url==='/api/snapshot')return json(res,200,{users:await users(),messages:await allMessages(),groups:await allGroups()});
if(req.url==='/api/ai'&&req.method==='POST'){const b=await body(req),message=String(b.message||'').trim();if(!message)return json(res,400,{error:'Пустое сообщение'});return json(res,200,{reply:await ai(message)})}
let file=req.url==='/'?'/index.html':req.url.split('?')[0];const fp=path.normalize(path.join(PUBLIC,file));if(!fp.startsWith(PUBLIC))return json(res,403,{error:'forbidden'});return fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}const ext=path.extname(fp),ct={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.mp3':'audio/mpeg','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':ct,'Cache-Control':'no-cache'});res.end(data)})
}catch(e){console.error('HTTP error:',e);if(!res.headersSent)json(res,500,{error:'Server error'})}});
const wss=new WebSocket.Server({server}),clients=new Map();
function sendTo(username,obj){for(const [ws,u] of clients)if(u.username===username&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function online(){return [...clients.values()].map(u=>u.username)}
async function snapshot(){return {users:await users(),messages:await allMessages(),groups:await allGroups()}}
wss.on('connection',ws=>{ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);ws.on('message',async raw=>{try{const m=JSON.parse(raw);if(m.type==='ping')return;if(m.type==='hello'&&m.user){const real=await findUser(m.user.username);if(!real)return;ws.user=clean(real);clients.set(ws,ws.user);ws.send(JSON.stringify({type:'snapshot',...(await snapshot()),online:online()}));for(const [x] of clients)if(x!==ws&&x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'presence',username:ws.user.username,online:true}));return}if(!ws.user)return;
if(m.type==='add-friend'){const target=String(m.username||'').replace(/^@/,'').trim().toLowerCase();if(!target||target===ws.user.username)return;const other=await findUser(target);if(!other)return ws.send(JSON.stringify({type:'error',message:'Пользователь не найден'}));const me=await findUser(ws.user.username);const mf=[...(me.friends||[])],of=[...(other.friends||[])];if(!mf.includes(target))mf.push(target);if(!of.includes(me.username))of.push(me.username);await updateFriends(me.username,mf);await updateFriends(other.username,of);ws.user={...me,friends:mf};sendTo(me.username,{type:'friends',friends:mf});sendTo(target,{type:'friends',friends:of});return}
if(m.type==='message'){const to=String(m.to||'').replace(/^@/,'').trim().toLowerCase(),text=String(m.text||'').trim().slice(0,4000);if(!to||!text)return;const me=await findUser(ws.user.username);if(!(me.friends||[]).includes(to))return ws.send(JSON.stringify({type:'error',message:'Сначала добавь пользователя в друзья'}));const msg={id:crypto.randomUUID(),from:ws.user.username,to,text,time:Date.now()};await addMessage(msg);sendTo(to,{type:'message',message:msg});ws.send(JSON.stringify({type:'message',message:msg}));return}
if(m.type==='group-create'){
 const name=String(m.name||'').trim().slice(0,50);
 if(!name){ws.send(JSON.stringify({type:'error',message:'Введите название группы'}));return}
 if(!ws.user){ws.send(JSON.stringify({type:'error',message:'Сначала войдите в аккаунт'}));return}
 const g={id:crypto.randomUUID(),name,owner:ws.user.username,members:[ws.user.username],createdAt:Date.now()};
 await addGroup(g);
 ws.send(JSON.stringify({type:'group',group:g,created:true}));
 for(const [x] of clients)if(x!==ws&&x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'group',group:g}));
 return
}
if(['call-offer','call-answer','ice','call-end'].includes(m.type)&&m.to)sendTo(String(m.to).replace(/^@/,'').toLowerCase(),{...m,from:ws.user.username});
}catch(e){console.error('WS error:',e);try{ws.send(JSON.stringify({type:'error',message:'Ошибка сервера'}))}catch{}}});ws.on('close',()=>{const u=clients.get(ws);clients.delete(ws);if(u)for(const [x] of clients)if(x.readyState===WebSocket.OPEN)x.send(JSON.stringify({type:'presence',username:u.username,online:false}))})});
setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive)return ws.terminate();ws.isAlive=false;ws.ping()}},30000);
init().then(()=>server.listen(PORT,HOST,()=>console.log(`craTe. listening on ${PORT}`))).catch(e=>{console.error('Startup error',e);process.exit(1)});
