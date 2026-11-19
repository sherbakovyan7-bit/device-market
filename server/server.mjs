import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const token = () => randomBytes(32).toString('hex');
export function createApp() {
  const devices = new Map(), sessions = new Map(), attempts = new Map();
  const reply = (res, status, body) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(body)); };
  const view = s => ({id:s.id, device:s.device, status:s.status, expiresAt:s.expiresAt, reason:s.reason});
  function sweep() {
    const now = Date.now();
    for (const [id,s] of sessions) {
      if (['pending','active'].includes(s.status) && now >= s.expiresAt) { s.status='ended'; s.reason='Время истекло'; }
      if (now > s.expiresAt+3600000) sessions.delete(id);
    }
    for (const [id,d] of devices) if(now-d.seen>120000) {
      devices.delete(id);
      for(const s of sessions.values()) if(s.device===id && s.status!=='ended') {s.status='ended';s.reason='Владелец отключился';s.expiresAt=now;}
    }
    for(const [ip,a] of attempts) if(now>a.until) attempts.delete(ip);
  }
  const interval=setInterval(sweep,1000);interval.unref();
  const server=http.createServer(async(req,res)=>{
    try {
      // Same-origin browser API; no cross-origin credentials or CORS access.
      const allowedOrigins=new Set([`http://${req.headers.host}`,process.env.PUBLIC_ORIGIN].filter(Boolean));
      if(req.headers.origin && !allowedOrigins.has(req.headers.origin)) return reply(res,403,{error:'Недопустимый источник'});
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET' && path==='/') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; connect-src 'self'"});
        return res.end(await readFile(new URL('./market.html',import.meta.url)));
      }
      if(path==='/api/health' && req.method==='GET') return reply(res,200,{ok:true,screenSharing:true,remoteControl:false});
      sweep();
      if(path==='/api/catalog'&&req.method==='GET')return reply(res,200,{devices:[...devices.values()].map(d=>({id:d.id,name:d.name,minutes:d.minutes,busy:[...sessions.values()].some(s=>s.device===d.id&&s.status!=='ended')}))});
      const frameMatch=path.match(/^\/api\/sessions\/([^/]+)\/frame$/);
      if(frameMatch){
        const s=sessions.get(frameMatch[1]),d=s&&devices.get(s.device),auth=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!s||!d||![d.secret,s.guest].includes(auth))return reply(res,403,{error:'Нет доступа'});
        if(s.status!=='active')return reply(res,409,{error:'Сеанс завершён'});
        if(req.method==='POST'){
          if(auth!==d.secret)return reply(res,403,{error:'Только владелец'});
          if(req.headers['content-type']!=='image/jpeg')return reply(res,415,{error:'Нужен JPEG'});
          let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>400000)return reply(res,413,{error:'Слишком большой кадр'});chunks.push(c)}
          const frame=Buffer.concat(chunks);if(frame[0]!==255||frame[1]!==216)return reply(res,400,{error:'Некорректный JPEG'});
          if(s.status!=='active')return reply(res,409,{error:'Сеанс завершён'});
          s.frame=frame;s.frameTime=Date.now();d.seen=Date.now();return reply(res,200,{ok:true});
        }
        if(req.method==='GET'){
          if(!s.frame||Date.now()-s.frameTime>5000){res.writeHead(204,{'Cache-Control':'no-store'});return res.end()}
          res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(s.frame);
        }
      }
      let body={};
      if(req.method==='POST') {
        if(!req.headers['content-type']?.startsWith('application/json')) return reply(res,415,{error:'Нужен JSON'});
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384){reply(res,413,{error:'Слишком большой запрос'});return;}}
        try{body=JSON.parse(raw)}catch{return reply(res,400,{error:'Некорректный JSON'})}
        if(!body || Array.isArray(body) || typeof body!=='object') return reply(res,400,{error:'Нужен объект'});
      }
      const auth=(req.headers.authorization||'').replace(/^Bearer /,'');
      if(path==='/api/devices' && req.method==='POST') {
        if(devices.size>=100) return reply(res,429,{error:'Лимит локального сервера'});
        if(typeof body.name!=='string'||!body.name.trim()||body.name.length>80||!Number.isInteger(body.minutes)||body.minutes<1||body.minutes>1440) return reply(res,400,{error:'Укажите название и время от 1 до 1440 минут'});
        const d={id:randomUUID(),name:body.name.trim(),minutes:body.minutes,secret:token(),code:randomBytes(6).toString('hex').toUpperCase(),codeUntil:Date.now()+600000,seen:Date.now()};
        devices.set(d.id,d);return reply(res,201,{id:d.id,ownerToken:d.secret,code:d.code,codeExpiresAt:d.codeUntil});
      }
      if(path==='/api/connect' && req.method==='POST') {
        const ip=req.socket.remoteAddress;const a=attempts.get(ip)||{count:0,until:Date.now()+60000};attempts.set(ip,a);
        if(++a.count>10) return reply(res,429,{error:'Слишком много попыток. Подождите минуту.'});
        const d=body.deviceId?devices.get(String(body.deviceId)):[...devices.values()].find(d=>d.code && d.code===String(body.code).trim().toUpperCase() && d.codeUntil>Date.now());
        if(!d) return reply(res,404,{error:'Код неверный или истёк'});
        if([...sessions.values()].some(s=>s.device===d.id && ['active','pending'].includes(s.status))) return reply(res,409,{error:'Устройство занято'});
        d.code=null;
        const s={id:randomUUID(),device:d.id,guest:token(),status:'pending',expiresAt:Date.now()+60000,reason:null};sessions.set(s.id,s);
        return reply(res,201,{...view(s),guestToken:s.guest});
      }
      const deviceMatch=path.match(/^\/api\/devices\/([^/]+)(?:\/(code))?$/);
      if(deviceMatch){
        const d=devices.get(deviceMatch[1]);if(!d||d.secret!==auth)return reply(res,403,{error:'Нет доступа владельца'});
        if(req.method==='GET'&&!deviceMatch[2]){d.seen=Date.now();return reply(res,200,{id:d.id,name:d.name,sessions:[...sessions.values()].filter(s=>s.device===d.id).map(view)});}
        if(req.method==='POST'&&deviceMatch[2]==='code'){
          if([...sessions.values()].some(s=>s.device===d.id && ['active','pending'].includes(s.status)))return reply(res,409,{error:'Сначала завершите текущий запрос или сеанс'});
          d.code=randomBytes(6).toString('hex').toUpperCase();d.codeUntil=Date.now()+600000;d.seen=Date.now();return reply(res,200,{code:d.code,codeExpiresAt:d.codeUntil});
        }
      }
      const match=path.match(/^\/api\/sessions\/([^/]+)(?:\/(approve|stop|signal))?$/);
      if(match){
        const s=sessions.get(match[1]),d=s&&devices.get(s.device);
        const owner=!!d&&auth===d.secret,guest=!!s&&auth===s.guest;
        if(!s||(!owner&&!guest))return reply(res,403,{error:'Нет доступа к сеансу'});
        if(match[2]==='signal'){
          if(s.status!=='active')return reply(res,409,{error:'Сеанс не активен'});
          if(req.method==='GET')return reply(res,200,{description:owner?s.answer||null:s.offer||null});
          if(req.method==='POST'){
            if(body.type!==(owner?'offer':'answer')||typeof body.sdp!=='string'||body.sdp.length>15000)return reply(res,400,{error:'Некорректное описание соединения'});
            if(owner)s.offer={type:body.type,sdp:body.sdp};else s.answer={type:body.type,sdp:body.sdp};
            return reply(res,200,{ok:true});
          }
        }
        if(req.method==='GET'&&!match[2])return reply(res,200,view(s));
        if(req.method==='POST'&&match[2]==='approve'){
          if(!owner)return reply(res,403,{error:'Только владелец может подтвердить'});
          if(s.status!=='pending')return reply(res,409,{error:'Запрос уже закрыт'});
          s.status='active';s.expiresAt=Date.now()+d.minutes*60000;d.seen=Date.now();return reply(res,200,view(s));
        }
        if(req.method==='POST'&&match[2]==='stop'){
          s.status='ended';delete s.frame;s.reason=owner?'Отключён владельцем':'Гость завершил сеанс';s.expiresAt=Date.now();return reply(res,200,view(s));
        }
      }
      reply(res,404,{error:'Маршрут не найден'});
    }catch(error){if(!res.headersSent)reply(res,500,{error:'Ошибка сервера'});else res.end();console.error(error.message);}
  });
  server.on('close',()=>clearInterval(interval));
  return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
  const server=createApp();server.on('error',e=>{console.error('Не удалось запустить сервер:',e.message);process.exitCode=1});
  server.listen(port,host,()=>console.log(`Device Market: http://${host}:${port}\nОстановка: Ctrl+C. Показ экрана: выберите источник в браузере владельца.`));
}
