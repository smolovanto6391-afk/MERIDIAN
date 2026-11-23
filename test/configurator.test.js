import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 42100 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), 'meridian-cfg-'));
const PW = 'cfg-pass-123';

async function start() {
  writeFileSync(join(dir, 'config.env'), `ADMIN_PASSWORD=${PW}\n`);
  const p = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: PW },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  p.stdout.on('data', d => out.push(d.toString()));
  p.stderr.on('data', d => out.push(d.toString()));
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return p; } catch {}
  }
  throw new Error('server did not start: ' + out.join(''));
}

const base = () => `http://127.0.0.1:${port}`;
const post = (path, body, headers = {}) => fetch(base() + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const OPTIONS = [
  {
    key: 'dial', label: 'Dial', labelZh: '表盘', values: [
      { id: 'blue', label: 'Blue', labelZh: '蓝', swatch: '#1f3f77', delta: 0, default: true },
      { id: 'cream', label: 'Cream', labelZh: '奶油', image: 'https://example.com/dial-cream.png', delta: 15 },
    ],
  },
  { key: 'strap', label: 'Strap', values: [{ id: 'steel', label: 'Steel', delta: 0 }] },
];
const TIERS = [{ qtyMin: 2, offPct: 10 }];
const ENGRAVING = { enabled: true, fee: 20, maxChars: 8, perUnit: false, label: 'Case back engraving', labelZh: '表背刻字' };

test('configurator: options, tiers, engraving, config code and quotation', async (t) => {
  const proc = await start();
  t.after(() => { proc.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });

  // 后台登录
  let r = await post('/api/login', { password: PW });
  assert.equal(r.status, 200);
  const cookie = (r.headers.getSetCookie?.() || [r.headers.get('set-cookie')]).filter(Boolean).map(c => c.split(';')[0]).join('; ');

  const putContent = async (mutate) => {
    const store = await (await fetch(base() + '/api/store')).json();
    const content = { ...store, products: store.products.map(mutate) };
    delete content.viewer; delete content.adminView; delete content.countries; delete content.shipping; delete content.contactEmail;
    const res = await fetch(base() + '/api/admin/content', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(content) });
    return res;
  };

  // 1. 非法选项标识应被拒绝
  r = await putContent(p => (p.id === 'p1' ? { ...p, options: [{ key: 'Bad Key!', label: 'x', values: [{ id: 'a', label: 'A' }] }] } : p));
  assert.equal(r.status, 400, 'invalid option key rejected');

  // 1b. 非法选项值也被拒绝（不静默丢弃）
  r = await putContent(p => (p.id === 'p1' ? { ...p, options: [{ key: 'dial', label: 'Dial', values: [{ id: 'bad id!', label: 'x' }] }] } : p));
  assert.equal(r.status, 400, 'invalid option value id rejected');

  // 1c. 非法阶梯（门槛 <2 或重复）被拒绝
  r = await putContent(p => (p.id === 'p1' ? { ...p, tiers: [{ qtyMin: 1, offPct: 50 }] } : p));
  assert.equal(r.status, 400, 'tier below 2 rejected');

  // 2. 正常保存并发布
  r = await putContent(p => (p.id === 'p1'
    ? { ...p, options: OPTIONS, tiers: TIERS, engraving: ENGRAVING, customizer: { enabled: true, x: 50, y: 50, size: 34 } }
    : p));
  assert.equal(r.status, 200, await r.text());
  r = await fetch(base() + '/api/admin/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
  assert.equal(r.status, 200);

  const store = await (await fetch(base() + '/api/store')).json();
  const p1 = store.products.find(p => p.id === 'p1');
  assert.equal(p1.options.length, 2, 'two groups kept');
  assert.equal(p1.options[0].values.length, 2, 'both dial values kept');
  assert.equal(p1.options[0].values[1].image, 'https://example.com/dial-cream.png');
  assert.equal(p1.options[0].values[0].default, true);
  assert.deepEqual(p1.tiers, [{ qtyMin: 2, offPct: 10 }], 'tier saved');
  assert.equal(p1.engraving.enabled, true);
  assert.equal(p1.engraving.fee, 20);
  assert.equal(p1.engraving.maxChars, 8);

  // 3. 下单：选项加价 + 数量阶梯 + 一次性刻字；客户端伪造加价必须被忽略
  r = await post('/api/orders', {
    name: 'Cfg Buyer', email: 'cfg@example.com', phone: '+1 617 555 0111',
    address: '9 Config Street', city: 'Boston', state: 'MA', postalCode: '02108', country: 'US',
    items: [{
      id: 'p1', quantity: 2,
      options: [{ key: 'dial', value: 'cream', delta: 999 }, { key: 'strap', value: 'steel' }],
      engraving: { text: 'A<B>C 1234567890' },
    }],
  });
  assert.ok([200, 201].includes(r.status), 'order created: ' + r.status + ' ' + await r.clone().text());
  const order = await r.json();
  const item = order.items[0];

  assert.equal(item.options.length, 2);
  assert.equal(item.options[0].delta, 15, 'client-sent delta ignored');
  assert.equal(item.engraving.text, 'ABC 1234', 'engraving stripped and capped at 8 chars');
  assert.equal(item.engraving.fee, 20);
  assert.equal(item.unitPrice, 183.6, '(189 + 15) with 10% multi-buy');
  assert.equal(item.tierOffPct, 10);
  assert.equal(item.config, 'CREAM/STEEL/ENG');
  assert.match(order.config, /CREAM\/STEEL\/ENG/);
  assert.equal(order.total, Number((183.6 * 2 + 20 + order.shipping).toFixed(2)));
  assert.equal(item.image, 'https://example.com/dial-cream.png', 'variant image snapshotted');

  // 4. 选项值不存在时回落到默认值（防止篡改，也不给旧客户端报错）
  r = await post('/api/orders', {
    name: 'X', email: 'x@example.com', phone: '+1 617 555 0112',
    address: '1 A', city: 'Boston', state: 'MA', postalCode: '02108', country: 'US',
    items: [{ id: 'p1', quantity: 1, options: [{ key: 'dial', value: 'gold' }] }],
  });
  assert.ok([200, 201].includes(r.status));
  const fallback = await r.json();
  assert.equal(fallback.items[0].options.find(o => o.key === 'dial').value, 'blue', 'falls back to default');
  assert.equal(fallback.items[0].options.find(o => o.key === 'strap').value, 'steel', 'missing group filled from first value');

  // 5. 询价：不进库存、不走支付，后台可见
  const before = await (await fetch(base() + '/api/store')).json();
  const stockBefore = before.products.find(p => p.id === 'p1').stock;
  r = await post('/api/quote', {
    productId: 'p1', email: 'rfq@example.com', name: 'RFQ Buyer', quantity: 25,
    options: [{ key: 'dial', value: 'cream' }], engraving: { text: 'TEAM' }, note: '需要 3 周内到货',
  });
  const quoteRaw = await r.text();
  assert.equal(r.status, 201, quoteRaw);
  const quote = JSON.parse(quoteRaw);
  assert.match(quote.id, /^RFQ\d+/);
  assert.equal(quote.estimate, Number((183.6 * 25 + 20).toFixed(2)));
  assert.equal(quote.config, 'CREAM/STEEL/ENG');
  const afterStore = await (await fetch(base() + '/api/store')).json();
  assert.equal(afterStore.products.find(p => p.id === 'p1').stock, stockBefore, 'quotation does not touch stock');

  r = await post('/api/quote', { productId: 'p1', email: 'not-an-email', quantity: 5 });
  assert.equal(r.status, 400);

  const list = await (await fetch(base() + '/api/admin/quotes', { headers: { cookie } })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, quote.id);
  assert.equal(list[0].status, 'new');
  r = await fetch(base() + '/api/admin/quotes/' + encodeURIComponent(quote.id), { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ status: 'quoted' }) });
  assert.equal(r.status, 200);
  const list2 = await (await fetch(base() + '/api/admin/quotes', { headers: { cookie } })).json();
  assert.equal(list2[0].status, 'quoted');
  r = await fetch(base() + '/api/admin/quotes/' + encodeURIComponent(quote.id), { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ status: 'bogus' }) });
  assert.equal(r.status, 400);
  // 6. 表盘 LOGO 工艺：一次性费用、配置码、非法工艺被拒绝
  const LOGO = [
    { id: 'laser', label: 'Laser engraving', labelZh: '激光刻字', fee: 5 },
    { id: 'label', label: 'Metal label', labelZh: '金属标', fee: 75, hint: '含开模' },
  ];
  r = await putContent(p => (p.id === 'p1' ? { ...p, logoMethods: LOGO } : p));
  assert.equal(r.status, 200, await r.text());
  r = await fetch(base() + '/api/admin/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
  assert.equal(r.status, 200);
  r = await putContent(p => (p.id === 'p1' ? { ...p, logoMethods: [{ id: 'Bad Id', label: 'x', fee: 1 }] } : p));
  assert.equal(r.status, 400, 'invalid logo method id rejected');
  r = await putContent(p => (p.id === 'p1' ? { ...p, logoMethods: [{ id: 'ok', label: 'x', fee: 999 }] } : p));
  assert.equal(r.status, 400, 'logo fee above cap rejected');
  assert.equal((await (await fetch(base() + '/api/store')).json()).products.find(p => p.id === 'p1').logoMethods[0].labelZh, '激光刻字');

  r = await post('/api/orders', {
    name: 'Logo Buyer', email: 'logo@example.com', phone: '+1 617 555 0113',
    address: '3 Logo Way', city: 'Boston', state: 'MA', postalCode: '02108', country: 'US',
    items: [{ id: 'p1', quantity: 1, logoMethod: 'label' }],
  });
  const lo = await r.json();
  assert.equal(lo.items[0].logoMethod.id, 'label');
  assert.equal(lo.items[0].logoMethod.fee, 75);
  assert.match(lo.items[0].config, /LABEL/);
  assert.equal(lo.total, Number((189 + 75 + lo.shipping).toFixed(2)), 'logo tooling fee charged once');

  r = await post('/api/orders', {
    name: 'Logo Bad', email: 'logo2@example.com', phone: '+1 617 555 0114',
    address: '4 Logo Way', city: 'Boston', state: 'MA', postalCode: '02108', country: 'US',
    items: [{ id: 'p1', quantity: 1, logoMethod: 'nope' }],
  });
  assert.equal(r.status, 400, 'unknown logo method rejected');

  r = await post('/api/quote', { productId: 'p1', email: 'q2@example.com', quantity: 10, logoMethod: 'laser' });
  const q2 = await r.json();
  assert.equal(r.status, 201, JSON.stringify(q2));
  assert.equal(q2.estimate, Number((170.1 * 10 + 5).toFixed(2)), 'quotation: tier price + one-time logo fee');
  // 7. 印刷风险标记：随订单快照、超长截断、可选
  r = await post('/api/orders', {
    name: 'Print Risk', email: 'print@example.com', phone: '+1 617 555 0115',
    address: '5 Ink Street', city: 'Boston', state: 'MA', postalCode: '02108', country: 'US',
    items: [{ id: 'p1', quantity: 1, printWarning: 'low-contrast 100% ' + 'x'.repeat(200) }],
  });
  const pr = await r.json();
  assert.equal(r.status, 201, JSON.stringify(pr));
  assert.equal(pr.items[0].printWarning.length, 60, 'print warning truncated to 60 chars');

  r = await post('/api/orders', {
    name: 'No Risk', email: 'norisk@example.com', phone: '+1 617 555 0116',
    address: '6 Ink Street', city: 'Boston', state: 'MA', postalCode: '02108', country: 'US',
    items: [{ id: 'p1', quantity: 1 }],
  });
  const nr = await r.json();
  assert.equal(nr.items[0].printWarning, undefined, 'no print warning when not flagged');
});
