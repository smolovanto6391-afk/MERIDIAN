// 极简事务邮件：零依赖，走 HTTP API（Resend / Postmark / SendGrid / 自建兼容端点）或 SMTP
import { smtpSend } from './smtp.js';
const PROVIDERS = ['resend', 'postmark', 'sendgrid', 'generic', 'smtp'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
const addressOnly = (v) => String(v || '').replace(/^.*</, '').replace(/>.*$/, '').trim();

export function createMailer(env = process.env, fetchImpl = fetch) {
  const provider = (env.MAIL_PROVIDER || 'resend').toLowerCase();
  const key = env.MAIL_API_KEY || '';
  const from = (env.MAIL_FROM || '').trim();
  const name = (env.MAIL_FROM_NAME || 'MERIDIAN').trim();
  const fromHeader = from ? (from.includes('<') ? from : `${name} <${from}>`) : '';
  const endpoint = provider === 'generic' ? (env.MAIL_API_URL || '') : '';
  const smtpHost = (env.MAIL_SMTP_HOST || '').trim();
  const enabled = Boolean(
    PROVIDERS.includes(provider) && fromHeader && (
      provider === 'smtp' ? smtpHost
      : key && (provider !== 'generic' || endpoint)));

  async function send({ to, subject, html, text }) {
    if (!enabled) throw Error('邮件未配置（MAIL_API_KEY / MAIL_FROM）');
    if (!/^\S+@\S+\.\S+$/.test(String(to || ''))) throw Error('收件地址无效');
    let url = endpoint, init;
    if (provider === 'smtp') {
      await smtpSend({
        host: smtpHost,
        port: Number(env.MAIL_SMTP_PORT || 587),
        secure: String(env.MAIL_SMTP_SECURE || '') === 'true',
        user: env.MAIL_SMTP_USER || '',
        pass: env.MAIL_SMTP_PASS || '',
        from: addressOnly(from), fromName: name,
        to, subject, text, html,
      });
      return true;
    }
    if (provider === 'resend') {
      url = 'https://api.resend.com/emails';
      init = { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fromHeader, to: [to], subject, html, text }) };
    } else if (provider === 'postmark') {
      url = 'https://api.postmarkapp.com/email';
      init = { method: 'POST', headers: { 'X-Postmark-Server-Token': key, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ From: fromHeader, To: to, Subject: subject, HtmlBody: html, TextBody: text }) };
    } else if (provider === 'sendgrid') {
      url = 'https://api.sendgrid.com/v3/mail/send';
      const address = from.replace(/^.*</, '').replace(/>.*$/, '');
      init = { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: address, name }, subject, content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }] }) };
    } else {
      init = { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fromHeader, to, subject, html, text }) };
    }
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch {}
      throw Error(`邮件服务返回 ${res.status}${detail ? ' ' + detail : ''}`);
    }
    return true;
  }

  return { enabled, provider, from: fromHeader, send };
}

export function orderEmail({ order, accessToken, brand = 'MERIDIAN', siteUrl = '', whatsapp = '' }) {
  const details = order.details || order;
  const items = Array.isArray(details.items) ? details.items : [];
  const optLine = (i) => (Array.isArray(i.options) && i.options.length)
    ? `<br><span style="color:#868686;font-size:12px">${i.options.map((o) => `${esc(o.label)}: ${esc(o.valueLabel)}${Number(o.delta) > 0 ? ` (+${money(Number(o.delta))})` : ''}`).join(' · ')}</span>` : '';
  const engLine = (i) => (i.engraving && i.engraving.text)
    ? `<br><span style="color:#868686;font-size:12px">Engraving “${esc(i.engraving.text)}” (+${money(Number(i.engraving.fee || 0))}${i.engraving.perUnit ? ' / unit' : ' one-time'})</span>` : '';
  const cfgLine = (i) => (i.config ? `<br><span style="color:#b0aca6;font-size:11px;letter-spacing:.08em">CFG ${esc(i.config)}</span>` : '');
  const rows = items.map((i) => `<tr><td style="padding:10px 0;border-bottom:1px solid #eee">${esc(i.name)}<br><span style="color:#868686;font-size:12px">× ${i.quantity} · ${money(i.unitPrice ?? i.price)} each${Number(i.fee||0)>0?` <span style="color:#868686;font-size:12px">(+ ${money(Number(i.fee))} custom dial)</span>`:''}</span>${optLine(i)}${engLine(i)}${cfgLine(i)}${i.artwork?`<br><span style="color:#868686;font-size:12px">Custom dial ${i.artwork.preview?'mock-up':'artwork'}: ${i.artwork.preview?`<br><img src="${esc(i.artwork.preview)}" alt="Custom dial mock-up" style="width:160px;border:1px solid #eee;border-radius:6px;margin-top:6px">`:''}<br><a href="${esc(i.artwork.preview||i.artwork.url)}">${esc(i.artwork.preview||i.artwork.url)}</a></span>`:''}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #eee">${money((i.unitPrice ?? i.price) * i.quantity)}</td></tr>`).join('');
  const payUrl = siteUrl && accessToken ? `${siteUrl}/?order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(accessToken)}` : '';
  const subject = `订单已收到 ${order.id} · ${brand}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f3;font-family:Georgia,serif;color:#333">
<div style="max-width:600px;margin:0 auto;background:#fff;padding:36px">
  <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#868686;margin:0 0 18px">${esc(brand)}</p>
  <h1 style="font-family:Arial,sans-serif;font-weight:300;font-size:26px;margin:0 0 6px">感谢您的订单</h1>
  <p style="margin:0 0 24px;color:#666">我们已收到您的订单，正在确认库存与配送信息。订单号 <strong>${esc(order.id)}</strong></p>
${details.note?`<div style="margin:0 0 18px;padding:12px 14px;background:#f7f5f0;border-left:3px solid #111;font-size:13px;line-height:1.5"><strong style="display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#868686;margin-bottom:4px">客户留言</strong>${esc(details.note)}</div>`:''}
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}
    <tr><td style="padding:10px 0;color:#666">小计</td><td align="right">${money(details.total - (details.shipping || 0))}</td></tr>
    <tr><td style="padding:4px 0;color:#666">运费</td><td align="right">${details.shipping ? money(details.shipping) : '免运费'}</td></tr>
    <tr><td style="padding:10px 0;border-top:1px solid #111;font-family:Arial,sans-serif;font-weight:600">合计</td><td align="right" style="border-top:1px solid #111;font-family:Arial,sans-serif;font-weight:600">${money(details.total)} USD</td></tr>
  </table>
  <h2 style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.16em;text-transform:uppercase;margin:28px 0 8px">收货信息</h2>
  <p style="margin:0;color:#555;font-size:14px;line-height:1.7">${esc(details.name)}<br>${esc(details.address)}<br>${esc(details.postalCode)} ${esc(details.country)}<br>${esc(details.phone)}</p>
  ${payUrl ? `<p style="margin:26px 0"><a href="${payUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 24px;font-family:Arial,sans-serif;font-size:12px;letter-spacing:.16em;text-transform:uppercase">查看订单与付款</a></p>` : ''}
  <p style="color:#868686;font-size:12px;line-height:1.7;margin:22px 0 0">付款确认后我们会立即安排发货。如需修改地址或咨询物流${whatsapp ? `，可通过 WhatsApp ${esc(whatsapp)} 联系我们` : '，请直接回复此邮件'}。</p>
</div>
<p style="max-width:600px;margin:14px auto 0;text-align:center;color:#9b9b9b;font-size:11px;font-family:Arial,sans-serif">© ${new Date().getFullYear()} ${esc(brand)}</p>
</body></html>`;
  const text = [
    `${brand} — 感谢您的订单`,
    `订单号: ${order.id}`,
    '',
    ...items.map((i) => [
      `${i.name} × ${i.quantity} — ${money((i.unitPrice ?? i.price) * i.quantity)}${i.artwork ? ` · artwork ${i.artwork.preview||i.artwork.url}` : ''}`,
      ...(Array.isArray(i.options) ? i.options.map((o) => `  ${o.label}: ${o.valueLabel}${Number(o.delta) > 0 ? ` (+${money(Number(o.delta))})` : ''}`) : []),
      ...(i.engraving && i.engraving.text ? [`  Engraving: "${i.engraving.text}" (+${money(Number(i.engraving.fee || 0))})`] : []),
      ...(i.config ? [`  CFG ${i.config}`] : []),
    ]).flat(),
    `小计: ${money(details.total - (details.shipping || 0))}`,
    `运费: ${details.shipping ? money(details.shipping) : '免运费'}`,
    `合计: ${money(details.total)} USD`,
    '',
    details.note?`客户留言: ${details.note}`:'',
    `${details.name} / ${details.address} / ${details.postalCode} ${details.country} / ${details.phone}`,
    payUrl ? `查看订单: ${payUrl}` : '',
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}

// 询价单通知（商家 + 抄送客户确认）
export function quoteEmail({ quote, brand = 'MERIDIAN', siteUrl = '' }) {
  const q = quote || {};
  const opts = Array.isArray(q.options) ? q.options : [];
  const cfgRow = (label, value) => (value === undefined || value === null || value === '' ? '' :
    `<tr><td style="padding:4px 12px 4px 0;color:#868686;font-size:13px;white-space:nowrap">${esc(label)}</td><td style="padding:4px 0;font-size:13px">${esc(value)}</td></tr>`);
  const subject = `询价 ${q.id} · ${q.productName || ''} · ${q.quantity || 1} pcs · ${brand}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f3;font-family:Georgia,serif;color:#333">
<div style="max-width:600px;margin:0 auto;background:#fff;padding:36px">
  <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#868686;margin:0 0 18px">${esc(brand)} · Quotation request</p>
  <h1 style="font-family:Arial,sans-serif;font-weight:300;font-size:24px;margin:0 0 6px">新的定制询价</h1>
  <p style="margin:0 0 22px;color:#666">询价单号 <strong>${esc(q.id)}</strong>${q.config ? ` · 配置 <strong>${esc(q.config)}</strong>` : ''}</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #eee;border-bottom:1px solid #eee;padding:10px 0">
    ${cfgRow('产品', q.productName)}
    ${cfgRow('数量', q.quantity)}
    ${opts.map((o) => cfgRow(o.label, `${o.valueLabel}${Number(o.delta) > 0 ? ` (+${money(Number(o.delta))})` : ''}`)).join('')}
    ${cfgRow('刻字', q.engraving && q.engraving.text ? q.engraving.text : '')}
    ${cfgRow('单件估价', q.unitEstimate !== undefined ? `${money(Number(q.unitEstimate))} (未含折扣)` : '')}
    ${cfgRow('合计估价', q.estimate !== undefined ? `${money(Number(q.estimate))} USD` : '')}
  </table>
  <h2 style="font-family:Arial,sans-serif;font-size:13px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 8px">联系方式</h2>
  <p style="margin:0 0 18px;color:#555;font-size:14px;line-height:1.7">${esc(q.name || '—')}${q.company ? ` · ${esc(q.company)}` : ''}<br>${esc(q.email)}${q.phone ? `<br>${esc(q.phone)}` : ''}${q.country ? `<br>${esc(q.country)}` : ''}</p>
  ${q.note ? `<div style="padding:12px 14px;background:#f7f5f0;border-left:3px solid #111;font-size:13px;line-height:1.6"><strong style="display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#868686;margin-bottom:4px">需求说明</strong>${esc(q.note)}</div>` : ''}
  <p style="color:#868686;font-size:12px;line-height:1.7;margin:22px 0 0">这是询价，不是订单：未占用库存，也未收款。回复此邮件即可报价。</p>
</div>
<p style="max-width:600px;margin:14px auto 0;text-align:center;color:#9b9b9b;font-size:11px;font-family:Arial,sans-serif">© ${new Date().getFullYear()} ${esc(brand)}</p>
</body></html>`;
  const text = [
    `${brand} — 新的定制询价`,
    `询价单号: ${q.id}`,
    `产品: ${q.productName || ''} × ${q.quantity || 1}`,
    ...opts.map((o) => `  ${o.label}: ${o.valueLabel}${Number(o.delta) > 0 ? ` (+${money(Number(o.delta))})` : ''}`),
    q.engraving && q.engraving.text ? `刻字: ${q.engraving.text}` : '',
    q.estimate !== undefined ? `合计估价: ${money(Number(q.estimate))} USD` : '',
    q.config ? `配置: ${q.config}` : '',
    '',
    `客户: ${q.name || '—'}${q.company ? ` / ${q.company}` : ''}`,
    `邮箱: ${q.email}`,
    q.phone ? `电话: ${q.phone}` : '',
    q.note ? `需求: ${q.note}` : '',
    siteUrl ? `后台: ${siteUrl}/admin` : '',
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
