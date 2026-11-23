import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// 加固回归：反代后的真实 IP 限流、后台敏感配置加密落库。
function start(env){
 return new Promise((resolve,reject)=>{
  const dir=mkdtempSync(join(tmpdir(),'meridian-hotfix-'));
  const port=52500+Math.floor(Math.random()*900);
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,DATA_DIR:dir,PORT:String(port),ADMIN_PASSWORD:'hotfix-pass',PUBLIC_BASE_URL:'https://shop.example.com',SETTINGS_KEY:'unit-test-settings-key',...env},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>{if(x.toString().includes(String(port)))resolve({child,dir,base:`http://127.0.0.1:${port}`});});
  child.stderr.on('data',x=>{if(!/ExperimentalWarning|trace-warnings/.test(x.toString()))reject(Error(x));});
  child.on('exit',c=>reject(Error('Exited '+c)));
  setTimeout(()=>reject(Error('Startup timed out')),12000).unref();
 });
}
const S=await start({});
after(()=>{S.child.kill();rmSync(S.dir,{recursive:true,force:true});});

const badLogin=ip=>fetch(S.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Real-IP':ip},body:JSON.stringify({password:'nope'})});

test('rate limiting keys on the forwarded client IP, not on 127.0.0.1',async()=>{
 for(let i=0;i<10;i++)assert.equal((await badLogin('203.0.113.7')).status,401);
 assert.equal((await badLogin('203.0.113.7')).status,429,'同一个真实 IP 达到上限后被限流');
 // 另一个访客必须不受影响（修复前所有人共用 127.0.0.1 的桶，会一起被锁）
 assert.equal((await badLogin('198.51.100.9')).status,401,'不同 IP 不应共享限流桶');
 // 正确的密码仍然可以从这个新 IP 登录
 const ok=await fetch(S.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Real-IP':'198.51.100.9'},body:JSON.stringify({password:'hotfix-pass'})});
 assert.equal(ok.status,200);
});

test('payment secrets are encrypted at rest and still usable',async()=>{
 const login=await fetch(S.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Real-IP':'198.51.100.10'},body:JSON.stringify({password:'hotfix-pass'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const put=await fetch(S.base+'/api/admin/payments',{method:'PUT',headers:{'Content-Type':'application/json','X-Real-IP':'198.51.100.10',Cookie:cookie},body:JSON.stringify({paypalEnabled:true,paypalMode:'sandbox',usdtEnabled:false,usdtNetwork:'trc20',usdtAddress:'',usdtRate:1,paypalClientId:'client-id-123',paypalClientSecret:'super-secret-value',paypalWebhookId:'wh-1'})});
 assert.equal(put.status,200);
 const view=await (await fetch(S.base+'/api/admin/payments',{headers:{Cookie:cookie}})).json();
 assert.equal(view.config.paypalClientSecretSet,true,'保存后仍认为已配置');
 assert.equal(view.readiness.paypalCredentials,true,'解密后凭证可用');
 assert.equal(view.config.paypalClientSecret,'','接口不回传明文');

 const db=new DatabaseSync(join(S.dir,'store.sqlite'));
 const raw=JSON.parse(db.prepare('SELECT value FROM payment_config WHERE id=1').get().value);
 db.close();
 assert.match(raw.paypalClientSecret,/^enc:v1:/,'落库应为密文');
 assert.ok(!JSON.stringify(raw).includes('super-secret-value'),'数据库里不应出现明文密钥');
});
