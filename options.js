// 商品配置模型：选项组（表盘/表圈/表带…）、数量阶梯优惠、表背刻字
// 服务端为唯一计价来源；前端只做展示与预估。
export const OPT_LIMITS = { groups: 6, values: 20, label: 40, delta: 500, tiers: 6, engFee: 500, engChars: 30 };

const clampNum = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const slug = (s, max) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);

// 站内 /uploads 或 https 图片；拒绝引号/尖括号等可注入字符
export const imagePathOK = (s) => typeof s === 'string' && s.length <= 500 &&
  (/^https:\/\/[^\s"'<>\\]+$/i.test(s) || /^\/[^/\s"'<>\\][^\s"'<>\\]*$/.test(s));

export function cleanOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw.slice(0, OPT_LIMITS.groups)) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    const key = slug(g.key, 20);
    if (!key || out.some((x) => x.key === key)) continue;
    const values = [];
    for (const v of (Array.isArray(g.values) ? g.values : []).slice(0, OPT_LIMITS.values)) {
      if (!v || typeof v !== 'object') continue;
      const id = slug(v.id, 24);
      if (!id || values.some((x) => x.id === id)) continue;
      const val = {
        id,
        label: String(v.label ?? id).trim().slice(0, OPT_LIMITS.label) || id,
        delta: clampNum(v.delta, 0, 0, OPT_LIMITS.delta),
      };
      const labelZh = String(v.labelZh || '').trim().slice(0, OPT_LIMITS.label);
      if (labelZh) val.labelZh = labelZh;
      if (imagePathOK(v.image) && v.image) val.image = v.image;
      if (typeof v.swatch === 'string' && /^#[0-9a-f]{6}$/i.test(v.swatch)) val.swatch = v.swatch.toLowerCase();
      if (v.default === true && !values.some((x) => x.default)) val.default = true;
      values.push(val);
    }
    if (!values.length) continue;
    const group = { key, label: String(g.label || key).trim().slice(0, OPT_LIMITS.label) || key, values };
    const labelZh = String(g.labelZh || '').trim().slice(0, OPT_LIMITS.label);
    if (labelZh) group.labelZh = labelZh;
    if (g.required === false) group.required = false;
    out.push(group);
  }
  return out;
}

// 数量阶梯：只做「多件优惠」，按百分比
export function cleanTiers(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), out = [];
  for (const t of raw.slice(0, 24)) {
    if (!t || typeof t !== 'object') continue;
    const qtyMin = Math.round(clampNum(t.qtyMin, 0, 2, 100000));
    if (qtyMin < 2 || seen.has(qtyMin)) continue;
    const offPct = clampNum(t.offPct, 0, 0, 90);
    if (offPct <= 0) continue;
    seen.add(qtyMin);
    out.push({ qtyMin, offPct: Math.round(offPct * 100) / 100 });
  }
  return out.sort((a, b) => a.qtyMin - b.qtyMin).slice(0, OPT_LIMITS.tiers);
}

export function cleanEngraving(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: o.enabled === true,
    fee: clampNum(o.fee, 25, 0, OPT_LIMITS.engFee),
    perUnit: o.perUnit === true,
    maxChars: Math.round(clampNum(o.maxChars, 10, 1, OPT_LIMITS.engChars)),
    label: String(o.label || 'Case back engraving').trim().slice(0, OPT_LIMITS.label),
    ...(String(o.labelZh || '').trim() ? { labelZh: String(o.labelZh).trim().slice(0, OPT_LIMITS.label) } : {}),
  };
}

export const tierFor = (tiers, quantity) => {
  let best = null;
  for (const t of Array.isArray(tiers) ? tiers : []) if (quantity >= t.qtyMin && (!best || t.qtyMin > best.qtyMin)) best = t;
  return best;
};

// 刻字文本：去控制字符、去尖括号、限长
export function cleanEngraveText(text, maxChars) {
  const s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Math.min(OPT_LIMITS.engChars, Number(maxChars) || 10)));
  return s;
}

// 校验并快照用户选择：未知分组/值一律拒绝，加价只取服务端配置
export function resolveSelections(product, chosen) {
  const groups = Array.isArray(product.options) ? product.options : [];
  const picked = [];
  for (const g of groups) {
    const hit = (Array.isArray(chosen) ? chosen : []).find((c) => c && c.key === g.key);
    const wanted = hit ? slug(hit.value, 24) : '';
    const val = g.values.find((v) => v.id === wanted) || g.values.find((v) => v.default) || (g.required === false ? null : g.values[0]);
    if (!val) {
      if (g.required === false) continue;
      throw Error('请选择' + (g.labelZh || g.label));
    }
    picked.push({ key: g.key, label: g.labelZh || g.label, value: val.id, valueLabel: val.labelZh || val.label, delta: val.delta || 0, ...(val.image ? { image: val.image } : {}) });
  }
  return picked;
}

// 计价（分为单位，服务端权威）
export function priceFor(product, { quantity, selections = [], artwork = null, engraving = null, customizerFee = 0 } = {}) {
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const baseCents = Math.round(Number(product.price || 0) * 100);
  const optionCents = selections.reduce((a, s) => a + Math.round(Number(s.delta || 0) * 100), 0);
  const tier = tierFor(product.tiers, qty);
  const grossCents = baseCents + optionCents;
  const unitCents = Math.round(grossCents * (1 - (tier ? tier.offPct : 0) / 100));
  const artworkCents = artwork ? Math.round(Number(customizerFee || 0) * 100) : 0;
  const cfg = product.engraving && product.engraving.enabled ? product.engraving : null;
  const text = cfg && engraving ? cleanEngraveText(engraving.text, cfg.maxChars) : '';
  const engFeeCents = text ? Math.round(Number(cfg.fee || 0) * 100) * (cfg.perUnit ? qty : 1) : 0;
  const totalCents = (unitCents + artworkCents) * qty + engFeeCents;
  return {
    qty,
    baseCents,
    optionCents,
    unitCents,
    artworkCents,
    tierOffPct: tier ? tier.offPct : 0,
    engraveText: text,
    engraveFeeCents: engFeeCents,
    totalCents,
    itemsCents: totalCents, // 运费按商品合计计算
  };
}

// 用户提交的刻字内容 → 规范化；商品未开启刻字时一律丢弃
export function engravingFor(product, raw) {
  const cfg = product.engraving && product.engraving.enabled ? product.engraving : null;
  if (!cfg) return null;
  const text = cleanEngraveText(raw && raw.text, cfg.maxChars);
  return text ? { text } : null;
}

// 可复制的配置编码，例如 BLUE/STEEL/LEATHER/ENG/ART
export function configCode(selections, { engraving = '', artwork = false } = {}) {
  const parts = (selections || []).map((s) => String(s.value || '').toUpperCase()).filter(Boolean);
  if (engraving) parts.push('ENG');
  if (artwork) parts.push('ART');
  return parts.join('/') || 'STD';
}
