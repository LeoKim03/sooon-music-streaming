const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STORE = path.join(ROOT, 'storage');
const AUDIO = path.join(STORE, 'audio');
const DB = path.join(STORE, 'library.json');
fs.mkdirSync(AUDIO, { recursive: true });
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { tracks: [], playlists: [] }; } };
const writeDb = db => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.wav':'audio/wav', '.ogg':'audio/ogg', '.flac':'audio/flac', '.opus':'audio/ogg', '.webm':'audio/webm' };
function send(res, code, body, type='application/json; charset=utf-8') { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
function authorized(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeName(s) { return path.basename(s || 'track').replace(/[\r\n\0]/g, '').slice(0, 180); }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,Range' }); return res.end(); }
  if (['POST','PATCH','DELETE'].includes(req.method) && u.pathname.startsWith('/api/')) {
    if (!process.env.ADMIN_PASSWORD) return send(res, 503, {error:'서버 운영자 비밀번호가 설정되지 않았습니다.'});
    if (!authorized(req)) return send(res, 401, {error:'운영자 비밀번호가 필요합니다.'});
  }
  if (req.method === 'GET' && u.pathname === '/api/library') return send(res, 200, readDb());
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks=[]; let size=0; req.on('data', c => { size += c.length; if (size > 600*1024*1024) { send(res, 413, {error:'파일은 최대 600MB까지 업로드할 수 있어요.'}); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const body=Buffer.concat(chunks); const boundary=(req.headers['content-type']||'').match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean); if (!boundary) return send(res,400,{error:'업로드 형식이 올바르지 않습니다.'});
      const marker=Buffer.from('--'+boundary); let i=0, added=[];
      while ((i=body.indexOf(marker,i)) !== -1) { i+=marker.length; if(body.slice(i,i+2).toString()==='--') break; if(body.slice(i,i+2).toString()==='\r\n') i+=2; const end=body.indexOf(Buffer.from('\r\n\r\n'),i); if(end<0) break; const header=body.slice(i,end).toString(); const next=body.indexOf(marker,end+4); if(next<0) break; const contentEnd=next-2; const filename=header.match(/filename="((?:\\.|[^"])*)"/i)?.[1]; if(filename){ const original=safeName(filename.replace(/\\"/g,'"')); const ext=path.extname(original).toLowerCase(); if(!['.mp3','.m4a','.aac','.wav','.ogg','.flac','.opus','.webm'].includes(ext)) { i=next; continue; } const id=crypto.randomUUID(); fs.writeFileSync(path.join(AUDIO,id+ext),body.subarray(end+4,contentEnd)); const track={id,name:path.basename(original,ext),file:original,artist:'내 음악',duration:0,addedAt:new Date().toISOString(),url:`/audio/${id}${ext}`}; added.push(track); } i=next;
      }
      if(!added.length) return send(res,400,{error:'지원하는 음악 파일을 찾지 못했습니다.'}); const db=readDb(); db.tracks.unshift(...added); writeDb(db); send(res,201,{tracks:added});
    }); return;
  }
  if (req.method === 'POST' && u.pathname === '/api/playlists') { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{try{const data=JSON.parse(b);const db=readDb();const p={id:crypto.randomUUID(),name:String(data.name||'새 플레이리스트').slice(0,80),description:'',trackIds:[],createdAt:new Date().toISOString()};db.playlists.unshift(p);writeDb(db);send(res,201,p);}catch{send(res,400,{error:'잘못된 요청'});}});return; }
  const pl=u.pathname.match(/^\/api\/playlists\/([\w-]+)$/);
  if(pl && req.method==='PATCH'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const data=JSON.parse(b),db=readDb(),p=db.playlists.find(x=>x.id===pl[1]);if(!p)return send(res,404,{error:'플레이리스트를 찾을 수 없습니다.'});if(typeof data.name==='string')p.name=data.name.slice(0,80);if(Array.isArray(data.trackIds))p.trackIds=[...new Set(data.trackIds)].filter(id=>db.tracks.some(t=>t.id===id));writeDb(db);send(res,200,p);}catch{send(res,400,{error:'잘못된 요청'});}});return;}
  if(pl && req.method==='DELETE'){const db=readDb();db.playlists=db.playlists.filter(x=>x.id!==pl[1]);writeDb(db);return send(res,200,{ok:true});}
  const audio=u.pathname.match(/^\/audio\/([\w-]+\.(?:mp3|m4a|aac|wav|ogg|flac|opus|webm))$/);
  if(audio && req.method==='GET') { const file=path.join(AUDIO,audio[1]); if(!fs.existsSync(file))return send(res,404,{error:'파일을 찾을 수 없습니다.'}); const stat=fs.statSync(file), range=req.headers.range; if(range){const [a,b]=range.replace(/bytes=/,'').split('-');const start=Number(a),end=b?Math.min(Number(b),stat.size-1):stat.size-1;res.writeHead(206,{'Content-Type':mime[path.extname(file)],'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes'});return fs.createReadStream(file,{start,end}).pipe(res);} res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Content-Length':stat.size,'Accept-Ranges':'bytes'});return fs.createReadStream(file).pipe(res); }
  if(req.method==='GET'){let p=decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname);let f=path.resolve(ROOT,'.'+p);if(!f.startsWith(ROOT+path.sep)||!fs.existsSync(f)||fs.statSync(f).isDirectory())return send(res,404,'Not found','text/plain');return res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'}),fs.createReadStream(f).pipe(res);}
  send(res,404,{error:'Not found'});
});
const port=Number(process.env.PORT)||3000;server.listen(port,'0.0.0.0',()=>console.log(`SoundVault running at http://localhost:${port}`));
