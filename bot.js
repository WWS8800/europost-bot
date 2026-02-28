const { Telegraf, Markup, session } = require('telegraf');

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8308565725:AAGO75B8opboDm9e7MQZL-25EF7M5umJRZQ';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wkjyymtqhdmwdalhddtn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indranl5bXRxaGRtd2RhbGhkZHRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTk5MzgsImV4cCI6MjA4NzYzNTkzOH0.ljR7uxunFpA2xUf2ij8K942W2E4uTwZrZA3T-aC3FFw';
const ADMIN_IDS = (process.env.ADMIN_IDS || '6367339097').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const MORNING_HOUR = parseInt(process.env.MORNING_HOUR || '9');

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing env variables: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

// ═══════════════════════════════════════
// SUPABASE CLIENT
// ═══════════════════════════════════════
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

async function sb(method, table, body = null, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${method} ${table}: ${err}`);
  }
  return method === 'DELETE' ? [] : res.json();
}

const db = {
  get: (table, params = '') => sb('GET', table, null, params),
  insert: (table, data) => sb('POST', table, data),
  update: (table, id, data, col = 'id') => sb('PATCH', table, data, `?${col}=eq.${id}`),
  delete: (table, id, col = 'id') => sb('DELETE', table, null, `?${col}=eq.${id}`)
};

// ═══════════════════════════════════════
// STATUS MAPS
// ═══════════════════════════════════════
const STATUS = {
  issued:    { l: '📋 Видана адреса',        next: 'ordered' },
  ordered:   { l: '📦 Замовлено (є трек)',   next: 'warehouse' },
  warehouse: { l: '🏭 На складі ЄС',         next: 'address' },
  address:   { l: '🏠 Отримано на адресі',   next: 'carrier' },
  carrier:   { l: '🚐 Передано перевізнику', next: 'np_sent' },
  np_sent:   { l: '📮 Відправлено НП',        next: 'ua' },
  ua:        { l: '🇺🇦 В UA',                next: 'delivered' },
  delivered: { l: '✅ Доставлено',            next: null },
  cancelled: { l: '❌ Скасовано',             next: null },
  legit:     { l: '👑 Легіт',                next: null },
};

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
const td = () => new Date().toISOString().split('T')[0];
const isAdmin = (id) => ADMIN_IDS.includes(id);

function fmt(p, clients = [], carriers = []) {
  const cl = clients.find(c => c.id === p.client_id) || { name: '?' };
  const cr = carriers.find(c => c.id === p.carrier_id) || { name: '—' };
  const st = STATUS[p.status] || { l: p.status };
  const paid1 = p.paid1 ? '✅' : '❌';
  const paid2 = p.paid2 ? '✅' : '❌';
  return [
    `📦 *${p.id}*`,
    `👤 ${cl.name}${cl.tg ? ' · ' + cl.tg : ''}`,
    `🏪 ${p.shop}${p.description ? ' · ' + p.description : ''}`,
    `📊 ${st.l}`,
    p.track ? `🔍 \`${p.track}\`` : '',
    `📅 Замовлено: ${p.date}${p.recv_date ? ' · Отримано: ' + p.recv_date : ''}`,
    `💰 Послуга: €${p.price} ${paid1} · Перевезення: €${p.ship_cost || 0} ${paid2}`,
    cr.name !== '—' ? `🚐 ${cr.name}` : '',
    p.recv_data ? `📍 ${p.recv_data}` : '',
    p.deliv_date ? `🎯 Доставлено: ${p.deliv_date}` : '',
    p.note ? `📝 ${p.note}` : '',
  ].filter(Boolean).join('\n');
}

function parcelButtons(p) {
  const btns = [];
  const st = STATUS[p.status];

  if (st?.next) {
    btns.push(Markup.button.callback(`▶ ${STATUS[st.next]?.l || st.next}`, `next_${p.id}`));
  }
  if (!p.paid1) btns.push(Markup.button.callback(`💰 Оплата послуги €${p.price}`, `pay1_${p.id}`));
  if (!p.paid2 && p.ship_cost > 0) btns.push(Markup.button.callback(`🚐 Оплата переїзду €${p.ship_cost}`, `pay2_${p.id}`));
  if (p.status !== 'cancelled') btns.push(Markup.button.callback('🚫 Скасувати', `cancel_${p.id}`));
  btns.push(Markup.button.callback('🔄 Оновити', `view_${p.id}`));

  return Markup.inlineKeyboard(btns.reduce((rows, btn, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push(btn);
    return rows;
  }, []));
}

// ═══════════════════════════════════════
// BOT INIT
// ═══════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

function initSession(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

// ═══════════════════════════════════════
// MAIN MENU
// ═══════════════════════════════════════
function mainMenu() {
  return Markup.keyboard([
    ['📦 Нова посилка', '🔍 Знайти посилку'],
    ['👥 Клієнти',      '🗂️ Грязні адреси'],
    ['📊 Звіт',         '💰 Боржники'],
    ['⚙️ Налаштування'],
  ]).resize();
}

bot.start(async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Доступ заборонено. Зверніться до адміністратора.');
  }
  initSession(ctx).step = null;
  await ctx.reply(
    `👋 Привіт, *${ctx.from.first_name}*\\!\n\nEuroPost CRM — панель управління\\.`,
    { parse_mode: 'MarkdownV2', ...mainMenu() }
  );
});

// ═══════════════════════════════════════
// PARCEL SEARCH — by ID or track
// ═══════════════════════════════════════
bot.hears('🔍 Знайти посилку', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  initSession(ctx).step = 'search_parcel';
  await ctx.reply('🔍 Введіть ID посилки (EU-XXXXXX) або tracking номер:', Markup.forceReply());
});

// ═══════════════════════════════════════
// QUICK VIEW — user types EU-XXXXXX directly
// ═══════════════════════════════════════
bot.hears(/^EU-\d+/i, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = ctx.message.text.trim().toUpperCase();
  await showParcel(ctx, id);
});

async function showParcel(ctx, id) {
  try {
    const [parcels, clients, carriers] = await Promise.all([
      db.get('parcels', `?id=eq.${id}`),
      db.get('clients', '?select=id,name,tg'),
      db.get('carriers', '?select=id,name'),
    ]);
    const p = parcels[0];
    if (!p) return ctx.reply(`❌ Посилку ${id} не знайдено`);
    await ctx.reply(fmt(p, clients, carriers), { parse_mode: 'Markdown', ...parcelButtons(p) });
  } catch (e) {
    ctx.reply('❌ Помилка: ' + e.message);
  }
}

// ═══════════════════════════════════════
// ADD PARCEL — step by step dialog
// ═══════════════════════════════════════
bot.hears('📦 Нова посилка', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const sess = initSession(ctx);
  sess.step = 'parcel_client';
  sess.newParcel = {};

  try {
    const clients = await db.get('clients', '?status=eq.active&select=id,name,tg&order=name');
    sess.clients = clients;

    const btns = clients.slice(0, 20).map(c =>
      [Markup.button.callback(c.name + (c.tg ? ` ${c.tg}` : ''), `pc_${c.id}`)]
    );
    btns.push([Markup.button.callback('➕ Новий клієнт', 'pc_new')]);

    await ctx.reply('👤 Оберіть клієнта:', Markup.inlineKeyboard(btns));
  } catch (e) {
    ctx.reply('❌ Помилка: ' + e.message);
  }
});

// Client selected
bot.action(/^pc_(\d+)$/, async (ctx) => {
  const sess = initSession(ctx);
  const cId = parseInt(ctx.match[1]);
  sess.newParcel.client_id = cId;
  sess.step = 'parcel_addr';
  await ctx.answerCbQuery();

  try {
    const addrs = await db.get('addresses', '?status=eq.free&select=id,name,street,house,city');
    sess.addresses = addrs;
    const btns = addrs.map(a =>
      [Markup.button.callback(`${a.name} · ${a.street} ${a.house}, ${a.city}`, `pa_${a.id}`)]
    );
    await ctx.editMessageText('📍 Оберіть адресу ЄС:', Markup.inlineKeyboard(btns));
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

// Address selected
bot.action(/^pa_(\d+)$/, async (ctx) => {
  const sess = initSession(ctx);
  sess.newParcel.addr_id = parseInt(ctx.match[1]);
  sess.step = 'parcel_shop';
  await ctx.answerCbQuery();

  const shops = ['Amazon', 'Aliexpress', 'About You', 'Zalando', 'H&M', 'Zara', 'eBay', 'ASOS'];
  const btns = shops.reduce((rows, s, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push(Markup.button.callback(s, `ps_${s}`));
    return rows;
  }, []);
  btns.push([Markup.button.callback('✏️ Інший магазин', 'ps_other')]);

  await ctx.editMessageText('🏪 Оберіть магазин:', Markup.inlineKeyboard(btns));
});

// Shop selected from buttons
bot.action(/^ps_(.+)$/, async (ctx) => {
  const sess = initSession(ctx);
  const shop = ctx.match[1];
  await ctx.answerCbQuery();

  if (shop === 'other') {
    sess.step = 'parcel_shop_text';
    await ctx.editMessageText('🏪 Введіть назву магазину:');
    return;
  }

  sess.newParcel.shop = shop;
  sess.step = 'parcel_track';
  await ctx.editMessageText(`🏪 Магазин: *${shop}*\n\n🔍 Введіть tracking номер (або натисніть /skip):`, { parse_mode: 'Markdown' });
});

// Price step after track
async function askPrice(ctx) {
  const sess = initSession(ctx);
  sess.step = 'parcel_price';
  await ctx.reply('💰 Вартість послуги €?\n(тільки число, наприклад: 35)');
}

// ═══════════════════════════════════════
// INLINE CALLBACKS — next status, pay, cancel
// ═══════════════════════════════════════
bot.action(/^next_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Немає доступу');
  const id = ctx.match[1];
  try {
    const parcels = await db.get('parcels', `?id=eq.${id}`);
    const p = parcels[0];
    if (!p) return ctx.answerCbQuery('❌ Не знайдено');

    const st = STATUS[p.status];
    if (!st?.next) return ctx.answerCbQuery('✅ Фінальний статус');

    const upd = { status: st.next };
    if (st.next === 'delivered') upd.deliv_date = td();

    await db.update('parcels', id, upd);
    await ctx.answerCbQuery(`✅ ${STATUS[st.next]?.l}`);
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('❌ ' + e.message); }
});

bot.action(/^pay1_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  try {
    const parcels = await db.get('parcels', `?id=eq.${id}`);
    const p = parcels[0];
    if (!p) return ctx.answerCbQuery('❌ Не знайдено');

    await db.update('parcels', id, { paid1: true });

    // Auto-create transaction
    const clients = await db.get('clients', `?id=eq.${p.client_id}&select=name`);
    const cl = clients[0] || { name: '?' };
    await db.insert('transactions', {
      date: td(), type: 'income',
      description: `Оплата послуги ${id}`,
      party: cl.name, parcel_ids: [id],
      amount: p.price, method: 'Переказ'
    });

    await ctx.answerCbQuery(`💰 Оплату €${p.price} зараховано`);
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('❌ ' + e.message); }
});

bot.action(/^pay2_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  try {
    const parcels = await db.get('parcels', `?id=eq.${id}`);
    const p = parcels[0];
    if (!p) return ctx.answerCbQuery('❌ Не знайдено');

    await db.update('parcels', id, { paid2: true });
    if (p.ship_cost > 0) {
      const clients = await db.get('clients', `?id=eq.${p.client_id}&select=name`);
      const cl = clients[0] || { name: '?' };
      await db.insert('transactions', {
        date: td(), type: 'income',
        description: `Оплата перевезення ${id}`,
        party: cl.name, parcel_ids: [id],
        amount: p.ship_cost, method: 'Переказ'
      });
    }
    await ctx.answerCbQuery(`🚐 Перевезення €${p.ship_cost || 0} оплачено`);
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('❌ ' + e.message); }
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  try {
    await db.update('parcels', id, { status: 'cancelled' });
    await ctx.answerCbQuery('❌ Посилку скасовано');
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('❌ ' + e.message); }
});

bot.action(/^view_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showParcel(ctx, ctx.match[1]);
});

// ═══════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════
bot.hears('📊 Звіт', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    const [parcels, clients] = await Promise.all([
      db.get('parcels', '?order=date.desc'),
      db.get('clients', '?select=id,name,tg')
    ]);

    const today = td();
    const todayP = parcels.filter(p => p.date === today);
    const byStatus = {};
    parcels.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });

    const revService = parcels.filter(p => p.paid1).reduce((s, p) => s + (p.price || 0), 0);
    const revShip = parcels.filter(p => p.paid2).reduce((s, p) => s + (p.ship_cost || 0), 0);
    const pending = parcels.filter(p => !p.paid1 && p.status !== 'cancelled').reduce((s, p) => s + (p.price || 0), 0);
    const pendShip = parcels.filter(p => !p.paid2 && p.ship_cost > 0 && p.status !== 'cancelled').reduce((s, p) => s + (p.ship_cost || 0), 0);

    const debtors = {};
    parcels.filter(p => p.status !== 'cancelled').forEach(p => {
      const owes = (p.paid1 ? 0 : (p.price || 0)) + (p.paid2 ? 0 : (p.ship_cost || 0));
      if (owes > 0) debtors[p.client_id] = (debtors[p.client_id] || 0) + owes;
    });

    const top3 = Object.entries(debtors)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([cid, amt]) => {
        const cl = clients.find(c => c.id === parseInt(cid)) || { name: '?' };
        return `  • ${cl.name} — €${amt}`;
      }).join('\n');

    const statusLines = Object.entries(STATUS)
      .filter(([k]) => byStatus[k])
      .map(([k, v]) => `  ${v.l}: ${byStatus[k] || 0}`)
      .join('\n');

    const msg = `📊 *Зведення EuroPost*
📅 ${new Date().toLocaleDateString('uk-UA')}

📦 *Посилки:*
  Всього: ${parcels.length}
  Сьогодні нових: ${todayP.length}

${statusLines}

💰 *Фінанси:*
  ✅ Отримано: €${revService + revShip}
  ⏳ Очікується: €${pending + pendShip}
    (послуги €${pending} + перевезення €${pendShip})

⚠️ *Топ боржників:*
${top3 || '  Боржників немає 🎉'}`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('❌ Помилка: ' + e.message);
  }
});

// ═══════════════════════════════════════
// DEBTORS
// ═══════════════════════════════════════
bot.hears('💰 Боржники', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    const [parcels, clients] = await Promise.all([
      db.get('parcels', '?status=neq.cancelled&select=client_id,price,ship_cost,paid1,paid2'),
      db.get('clients', '?select=id,name,tg,phone')
    ]);

    const debtMap = {};
    parcels.forEach(p => {
      const owes = (p.paid1 ? 0 : (p.price || 0)) + (p.paid2 ? 0 : (p.ship_cost || 0));
      if (owes > 0) debtMap[p.client_id] = (debtMap[p.client_id] || 0) + owes;
    });

    const sorted = Object.entries(debtMap)
      .sort((a, b) => b[1] - a[1])
      .map(([cid, amt]) => {
        const cl = clients.find(c => c.id === parseInt(cid)) || { name: '?' };
        return `💸 *${cl.name}* — €${amt}\n  ${cl.tg || ''} ${cl.phone || ''}`;
      });

    if (!sorted.length) return ctx.reply('🎉 Боржників немає!');

    const total = Object.values(debtMap).reduce((s, v) => s + v, 0);
    const msg = `💰 *Боржники (${sorted.length})*\nЗагалом: €${total}\n\n${sorted.join('\n\n')}`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('❌ ' + e.message);
  }
});

// ═══════════════════════════════════════
// DIRTY ADDRESSES — quick add
// ═══════════════════════════════════════
bot.hears('🗂️ Грязні адреси', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply(
    '🗂️ *Грязні адреси*\n\nОберіть дію:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Додати запис', 'da_add')],
        [Markup.button.callback('🔍 Перевірити адресу', 'da_check')],
        [Markup.button.callback('📋 Останні 10 записів', 'da_list')],
      ])
    }
  );
});

bot.action('da_add', async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx).step = 'dirty_addr';
  initSession(ctx).newDirty = {};
  await ctx.reply('📍 Введіть адресу (наприклад: Maria Basov Breslauer Straße 44a):');
});

bot.action('da_check', async (ctx) => {
  await ctx.answerCbQuery();
  initSession(ctx).step = 'dirty_check';
  await ctx.reply('🔍 Введіть адресу для перевірки:');
});

bot.action('da_list', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const records = await db.get('dirty_addresses', '?order=id.desc&limit=10');
    if (!records.length) return ctx.reply('📋 Записів немає');
    const msg = records.map(r =>
      `📍 *${r.addr}*\n  🏪 ${r.shop} · 👤 ${r.tg || '—'} · 📅 ${r.date || '—'} · ${r.method || '—'}`
    ).join('\n\n');
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

// ═══════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════
bot.hears('👥 Клієнти', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    const clients = await db.get('clients', '?order=name&select=id,name,phone,tg,status');
    if (!clients.length) return ctx.reply('👥 Клієнтів немає');

    const msg = clients.map(c =>
      `👤 *${c.name}*\n  📞 ${c.phone || '—'} · ${c.tg || '—'}`
    ).join('\n\n');

    await ctx.reply(`👥 *Клієнти (${clients.length})*\n\n${msg}`, { parse_mode: 'Markdown' });
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

// ═══════════════════════════════════════
// TEXT MESSAGE HANDLER — step-by-step dialogs
// ═══════════════════════════════════════
bot.on('text', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const sess = initSession(ctx);
  const text = ctx.message.text.trim();

  // Skip /commands
  if (text.startsWith('/')) return;

  // ── PARCEL DIALOG ──
  if (sess.step === 'parcel_shop_text') {
    sess.newParcel.shop = text;
    sess.step = 'parcel_track';
    return ctx.reply(`🏪 Магазин: *${text}*\n\n🔍 Введіть tracking номер (або /skip):`, { parse_mode: 'Markdown' });
  }

  if (sess.step === 'parcel_track') {
    sess.newParcel.track = text === '/skip' ? null : text;
    return askPrice(ctx);
  }

  if (sess.step === 'parcel_price') {
    const price = parseFloat(text.replace(',', '.'));
    if (isNaN(price)) return ctx.reply('⚠️ Введіть число, наприклад: 35');
    sess.newParcel.price = price;
    sess.step = 'parcel_ship';
    return ctx.reply('🚐 Вартість перевезення € (або /skip якщо невідомо):');
  }

  if (sess.step === 'parcel_ship') {
    sess.newParcel.ship_cost = text === '/skip' ? 0 : (parseFloat(text.replace(',', '.')) || 0);
    sess.step = 'parcel_note';
    return ctx.reply('📝 Примітка (або /skip):');
  }

  if (sess.step === 'parcel_note') {
    sess.newParcel.note = text === '/skip' ? null : text;
    // Save parcel
    try {
      const newId = 'EU-' + String(Date.now()).slice(-6);
      const data = {
        id: newId,
        ...sess.newParcel,
        date: td(),
        status: 'issued',
        paid1: false,
        paid2: false,
      };
      await db.insert('parcels', data);
      sess.step = null;
      sess.newParcel = {};

      await ctx.reply(
        `✅ *Посилку ${newId} створено\\!*\n\n` +
        `🏪 ${data.shop}\n` +
        `💰 Послуга: €${data.price} · Перевезення: €${data.ship_cost || 0}\n` +
        `📊 Статус: 📋 Видана адреса`,
        { parse_mode: 'MarkdownV2', ...mainMenu() }
      );
    } catch (e) {
      ctx.reply('❌ Помилка збереження: ' + e.message);
    }
    return;
  }

  // ── DIRTY ADDRESS DIALOG ──
  if (sess.step === 'dirty_addr') {
    sess.newDirty.addr = text;
    sess.step = 'dirty_shop';
    const shops = ['Amazon', 'Aliexpress', 'About You', 'Zalando', 'H&M', 'Zara', 'ASOS'];
    const btns = shops.reduce((rows, s, i) => {
      if (i % 3 === 0) rows.push([]);
      rows[rows.length - 1].push(Markup.button.callback(s, `ds_${s}`));
      return rows;
    }, []);
    btns.push([Markup.button.callback('✏️ Інший', 'ds_other')]);
    return ctx.reply('🏪 Магазин:', Markup.inlineKeyboard(btns));
  }

  if (sess.step === 'dirty_shop_text') {
    sess.newDirty.shop = text;
    sess.step = 'dirty_tg';
    return ctx.reply('👤 Telegram замовника (або /skip):');
  }

  if (sess.step === 'dirty_tg') {
    let tg = text === '/skip' ? '' : text;
    if (tg && !tg.startsWith('@')) tg = '@' + tg;
    sess.newDirty.tg = tg;
    sess.step = 'dirty_method';
    return ctx.reply('📋 Метод:', Markup.inlineKeyboard([
      [Markup.button.callback('FTID', 'dm_FTID'), Markup.button.callback('RTS', 'dm_RTS')],
      [Markup.button.callback('DAMAGE', 'dm_DAMAGE'), Markup.button.callback('DNA', 'dm_DNA')],
      [Markup.button.callback('Зберігаємо', 'dm_Зберігаємо')],
    ]));
  }

  if (sess.step === 'dirty_check') {
    try {
      const q = encodeURIComponent(text);
      const records = await db.get('dirty_addresses', `?addr=ilike.*${text}*&limit=5`);
      if (!records.length) return ctx.reply(`✅ Адреса *${text}* не знайдена в базі.`, { parse_mode: 'Markdown' });
      const msg = records.map(r =>
        `⚠️ *${r.addr}*\n  🏪 ${r.shop} · 👤 ${r.tg || '—'} · 📅 ${r.date || '—'} · ${r.method || '—'}`
      ).join('\n\n');
      await ctx.reply(`🔍 Знайдено ${records.length} записів:\n\n${msg}`, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply('❌ ' + e.message); }
    sess.step = null;
    return;
  }

  // ── SEARCH ──
  if (sess.step === 'search_parcel') {
    sess.step = null;
    const q = text.toUpperCase();
    try {
      let parcels = [];
      if (q.startsWith('EU-')) {
        parcels = await db.get('parcels', `?id=eq.${q}`);
      } else {
        parcels = await db.get('parcels', `?track=eq.${text}`);
      }
      if (!parcels.length) return ctx.reply(`❌ Нічого не знайдено за запитом: ${text}`);
      const p = parcels[0];
      const [clients, carriers] = await Promise.all([
        db.get('clients', '?select=id,name,tg'),
        db.get('carriers', '?select=id,name')
      ]);
      await ctx.reply(fmt(p, clients, carriers), { parse_mode: 'Markdown', ...parcelButtons(p) });
    } catch (e) { ctx.reply('❌ ' + e.message); }
    return;
  }
});

// Dirty shop/method callbacks
bot.action(/^ds_(.+)$/, async (ctx) => {
  const sess = initSession(ctx);
  await ctx.answerCbQuery();
  const val = ctx.match[1];
  if (val === 'other') {
    sess.step = 'dirty_shop_text';
    return ctx.editMessageText('🏪 Введіть назву магазину:');
  }
  sess.newDirty.shop = val;
  sess.step = 'dirty_tg';
  await ctx.editMessageText(`🏪 ${val}\n\n👤 Telegram замовника (або /skip):`);
});

bot.action(/^dm_(.+)$/, async (ctx) => {
  const sess = initSession(ctx);
  await ctx.answerCbQuery();
  sess.newDirty.method = ctx.match[1];
  // Save
  try {
    const data = { ...sess.newDirty, date: new Date().toLocaleDateString('uk-UA') };
    await db.insert('dirty_addresses', data);
    sess.step = null;
    sess.newDirty = {};
    await ctx.editMessageText(`✅ Запис додано!\n\n📍 ${data.addr}\n🏪 ${data.shop} · ${data.tg || '—'} · ${data.method}`);
  } catch (e) { ctx.reply('❌ ' + e.message); }
});

// ═══════════════════════════════════════
// MORNING REPORT — scheduled
// ═══════════════════════════════════════
async function sendMorningReport() {
  if (!ADMIN_IDS.length) return;
  try {
    const [parcels, clients] = await Promise.all([
      db.get('parcels', '?order=date.desc'),
      db.get('clients', '?select=id,name,tg')
    ]);

    const today = td();
    const byStatus = {};
    parcels.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });

    const pending = parcels.filter(p => !p.paid1 && p.status !== 'cancelled').reduce((s, p) => s + (p.price || 0), 0);
    const debtMap = {};
    parcels.filter(p => p.status !== 'cancelled').forEach(p => {
      const owes = (p.paid1 ? 0 : (p.price || 0)) + (p.paid2 ? 0 : (p.ship_cost || 0));
      if (owes > 0) debtMap[p.client_id] = (debtMap[p.client_id] || 0) + owes;
    });

    const top3 = Object.entries(debtMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([cid, amt]) => {
        const cl = clients.find(c => c.id === parseInt(cid)) || { name: '?' };
        return `  • ${cl.name} — €${amt}`;
      }).join('\n');

    const msg = `☀️ *Доброго ранку\\! Зведення EuroPost*
📅 ${new Date().toLocaleDateString('uk-UA')}

📦 Всього посилок: ${parcels.length}
  На складі ЄС: ${byStatus.warehouse || 0}
  На адресі: ${byStatus.address || 0}
  В дорозі: ${byStatus.carrier || 0}
  В UA: ${byStatus.ua || 0}

💰 Очікується оплат: €${pending}
⚠️ Боржників: ${Object.keys(debtMap).length}
${top3 ? '\nТоп боржників:\n' + top3 : ''}`;

    for (const adminId of ADMIN_IDS) {
      await bot.telegram.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2' });
    }
  } catch (e) {
    console.error('Morning report error:', e.message);
  }
}

// Schedule morning report
function scheduleMorning() {
  const now = new Date();
  const next = new Date();
  next.setHours(MORNING_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  console.log(`⏰ Ранкова зведення через ${Math.round(ms / 60000)} хв`);
  setTimeout(() => {
    sendMorningReport();
    setInterval(sendMorningReport, 24 * 60 * 60 * 1000);
  }, ms);
}

// ═══════════════════════════════════════
// LAUNCH
// ═══════════════════════════════════════
bot.launch().then(() => {
  console.log('🚀 EuroPost Bot запущено!');
  scheduleMorning();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
