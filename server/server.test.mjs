import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from './server.mjs';

test('owner authorizes, single-use code, isolation, stop and fresh code',async()=>{
 const server=createApp();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/api/`;
 const call=async(path,body,token,method='POST')=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}};
 try{
  assert.equal((await call('devices',{name:'test',minutes:0})).status,400);
  const {body:d}=await call('devices',{name:'test',minutes:1});
  const catalog=await call('catalog',null,null,'GET');assert.equal(catalog.body.devices[0].id,d.id);assert.equal(catalog.body.devices[0].secret,undefined);
  const {body:s}=await call('connect',{code:d.code});assert.equal(s.status,'pending');
  assert.equal((await call('connect',{code:d.code})).status,404);
  assert.equal((await call(`sessions/${s.id}/approve`,{},s.guestToken)).status,403);
  assert.equal((await call(`sessions/${s.id}`,null,'wrong','GET')).status,403);
  const approved=await call(`sessions/${s.id}/approve`,{},d.ownerToken);assert.equal(approved.body.status,'active');
  assert.ok(approved.body.expiresAt>Date.now()+55000);
  const frameUrl=base+`sessions/${s.id}/frame`;
  assert.equal((await fetch(frameUrl)).status,403);
  assert.equal((await fetch(frameUrl,{headers:{Authorization:'Bearer '+s.guestToken}})).status,204);
  const frame=Buffer.from([255,216,255,217]);
  assert.equal((await fetch(frameUrl,{method:'POST',headers:{Authorization:'Bearer '+s.guestToken,'Content-Type':'image/jpeg'},body:frame})).status,403);
  assert.equal((await fetch(frameUrl,{method:'POST',headers:{Authorization:'Bearer '+d.ownerToken,'Content-Type':'image/jpeg'},body:frame})).status,200);
  assert.deepEqual(Buffer.from(await (await fetch(frameUrl,{headers:{Authorization:'Bearer '+s.guestToken}})).arrayBuffer()),frame);
  assert.equal((await call(`sessions/${s.id}/signal`,{type:'offer',sdp:'test-offer'},s.guestToken)).status,400);
  assert.equal((await call(`sessions/${s.id}/signal`,{type:'offer',sdp:'test-offer'},d.ownerToken)).status,200);
  assert.equal((await call(`sessions/${s.id}/signal`,null,s.guestToken,'GET')).body.description.sdp,'test-offer');
  assert.equal((await call(`sessions/${s.id}/signal`,{type:'answer',sdp:'test-answer'},s.guestToken)).status,200);
  assert.equal((await call(`sessions/${s.id}/signal`,null,d.ownerToken,'GET')).body.description.sdp,'test-answer');
  assert.equal((await call(`devices/${d.id}/code`,{},d.ownerToken)).status,409);
  assert.equal((await call(`sessions/${s.id}/stop`,{},d.ownerToken)).body.status,'ended');
  assert.equal((await call(`sessions/${s.id}`,null,s.guestToken,'GET')).body.status,'ended');
  assert.equal((await call(`sessions/${s.id}/approve`,{},d.ownerToken)).status,409);
  assert.equal((await fetch(frameUrl,{headers:{Authorization:'Bearer '+s.guestToken}})).status,409);
  assert.equal((await call(`sessions/${s.id}/signal`,null,s.guestToken,'GET')).status,409);
  assert.equal((await call(`devices/${d.id}/code`,{},d.ownerToken)).status,200);
 }finally{await new Promise(r=>server.close(r))}
});
