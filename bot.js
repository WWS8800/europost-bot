const { Telegraf, Markup, session } = require('telegraf');

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8308565725:AAGO75B8opboDm9e7MQZL-25EF7M5umJRZQ';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wkjyymtqhdmwdalhddtn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indranl5bXRxaGRtd2RhbGhkZHRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNTk5MzgsImV4cCI6MjA4NzYzNTkzOH0.ljR7uxunFpA2xUf2ij8K942W2E4uTwZrZA3T-aC3FFw';
const ADMIN_IDS = (process.env.ADMIN_IDS || '6367339097').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const MORNING_HOUR = parseInt(process.env.MORNING_HOUR || '9');
const PAGE_SIZE = 10;

// ═══════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

async function sbGet(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  });
  if (!res.ok) throw new Error(`GET ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPost(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`POST ${table}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, id, data, col = 'id') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`PATCH ${table}: ${await res.text()}`);
  return res.json();
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
const td = () => new Date().toLocaleDateString('uk-UA').split('.').reverse().join('-');
const isAdmin = (id) => ADMIN_IDS.includes(id);

// Safe markdown - escape special chars for Markdown (not V2)
function safe(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

const STATUS = {
  issued:    { l: 'Видана адреса',          e: '📋' },
  ordered:   { l: 'Замовлено (є трек)',     e: '📦' },
  warehouse: { l: 'На відділенні',          e: '🏪' },
  address:   { l: 'Отримано на адресі',     e: '🏠' },
  carrier:   { l: 'Передано перевізнику',   e: '🚐' },
  np_sent:   { l: 'Відправлено НП',         e: '📮' },
  ua:        { l: 'В UA',                   e: '🇺🇦' },
  delivered: { l: 'Доставлено',             e: '✅' },
  cancelled: { l: 'Скасовано',              e: '❌' },
  legit:     { l: 'Легіт',                  e: '👑' },
};

const STATUS_FLOW = ['issued','ordered','warehouse','address','carrier','np_sent','ua','delivered'];

function getNextStatus(current) {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx >= 0 && idx < STATUS_FLOW.length - 1) return STATUS_FLOW[idx + 1];
  return null;
}

function fmtParcel(p, clients = [], carriers = [], addresses = []) {
  const cl = clients.find(c => c.id === p.client_id) || { name: '?' };
  const cr = carriers.find(c => c.id === p.carrier_id) || { name: '' };
  const addr = addresses.find(a => a.id === p.addr_id);
  const st = STATUS[p.status] || { l: p.status, e: '📦' };
  const addrShort = addr ? addr.name : null;
  const lines = [
    `*${p.id}*`,
    `${st.e} ${st.l}`,
    `👤 ${safe(cl.name)}`,
    `🏪 ${safe(p.shop)}${p.description ? ' — ' + safe(p.description) : ''}`,
    addrShort ? `📍 ${safe(addrShort)}` : null,
    p.track ? `🔍 \`${p.track}\`` : null,
    `📅 ${p.date}${p.recv_date ? ' | Отримано: ' + p.recv_date : ''}`,
    `💰 Послуга: €${p.price} ${p.paid1 ? '✅' : '❌'}`,
    `🚐 Перевезення: €${p.ship_cost || 0} ${p.paid2 ? '✅' : '❌'}`,
    cr.name ? `🏢 ${safe(cr.name)}` : null,
    p.recv_data ? `📦 ${safe(p.recv_data)}` : null,
    p.deliv_date ? `🎯 Доставлено: ${p.deliv_date}` : null,
    p.note ? `📝 ${safe(p.note)}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function parcelActions(p) {
  const rows = [];
  const next = getNextStatus(p.status);
  if (next) {
    const ns = STATUS[next];
    rows.push([Markup.button.callback(`▶ ${ns.e} ${ns.l}`, `next_${p.id}`)]);
  }
  const payRow = [];
  if (!p.paid1) payRow.push(Markup.button.callback(`💰 Оплата €${p.price}`, `pay1_${p.id}`));
  if (!p.paid2 && p.ship_cost > 0) payRow.push(Markup.button.callback(`🚐 Перевезення €${p.ship_cost}`, `pay2_${p.id}`));
  if (payRow.length) rows.push(payRow);

  // Add ship cost button if not set
  if (!p.ship_cost || p.ship_cost === 0) {
    rows.push([Markup.button.callback('➕ Додати вартість перевезення', `addship_${p.id}`)]);
  }

  if (!['cancelled','delivered','legit'].includes(p.status)) {
    rows.push([Markup.button.callback('🚫 Скасувати', `cancel_${p.id}`)]);
  }
  rows.push([
    Markup.button.callback('🔄 Оновити', `view_${p.id}`),
    Markup.button.callback('« Назад', 'back_main')
  ]);
  return Markup.inlineKeyboard(rows);
}

// ═══════════════════════════════════════
// BOT
// ═══════════════════════════════════════
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());


function sess(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

function mainMenu() {
  return Markup.keyboard([
    ['📦 Нова посилка', '🔍 Знайти посилку'],
    ['👥 Клієнти',      '➕ Новий клієнт'],
    ['📍 Видати адресу','🗂 Грязні адреси'],
    ['📊 Звіт',         '💰 Боржники'],
  ]).resize();
}

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
bot.start(async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Доступ заборонено.');
  sess(ctx).step = null;
  await ctx.reply(`Привіт, ${ctx.from.first_name}!\n\nEuroPost CRM — панель управління.`, mainMenu());
});

// ═══════════════════════════════════════
// BACK BUTTON
// ═══════════════════════════════════════
bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).step = null;
  try { await ctx.deleteMessage(); } catch(e) {}
  await ctx.reply('Головне меню:', mainMenu());
});

bot.action('back_clients', async (ctx) => {
  await ctx.answerCbQuery();
  await showClients(ctx, 0);
});

bot.action(/^back_parcels_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cId = parseInt(ctx.match[1]);
  await showClientParcels(ctx, cId, 0);
});


// ═══════════════════════════════════════
// ADD CLIENT — dialog
// ═══════════════════════════════════════
bot.hears(/Новий клієнт/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const s = sess(ctx);
  s.step = 'client_name';
  s.newClient = {};
  await ctx.reply('Додаємо нового клієнта\n\nВведіть імя та прізвище:');
});

bot.action('add_client', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.step = 'client_name';
  s.newClient = {};
  try { await ctx.editMessageText('Додаємо нового клієнта\n\nВведіть імя та прізвище:'); } catch(e) {}
});

// ═══════════════════════════════════════
// CLIENTS — paginated list
// ═══════════════════════════════════════
bot.hears(/Клієнти/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showClients(ctx, 0);
});

async function showClients(ctx, page) {
  try {
    const clients = await sbGet('clients', '?order=name&select=id,name,phone,tg');
    const total = clients.length;
    const start = page * PAGE_SIZE;
    const slice = clients.slice(start, start + PAGE_SIZE);

    const rows = slice.map(c =>
      [Markup.button.callback(
        `${c.name}${c.tg ? ' ' + c.tg : ''}`,
        `cl_${c.id}`
      )]
    );

    // Pagination
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('« Назад', `clpage_${page - 1}`));
    if (start + PAGE_SIZE < total) navRow.push(Markup.button.callback('Далі »', `clpage_${page + 1}`));
    if (navRow.length) rows.push(navRow);
    rows.push([Markup.button.callback('➕ Новий клієнт', 'add_client')]);
    rows.push([Markup.button.callback('« Головне меню', 'back_main')]);

    const text = `Клієнти (${total})\nСторінка ${page + 1} з ${Math.ceil(total / PAGE_SIZE) || 1}:`;

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, Markup.inlineKeyboard(rows));
    } else {
      await ctx.reply(text, Markup.inlineKeyboard(rows));
    }
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
}

bot.action(/^clpage_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showClients(ctx, parseInt(ctx.match[1]));
});

bot.action(/^cl_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cId = parseInt(ctx.match[1]);
  await showClientParcels(ctx, cId, 0);
});

// ═══════════════════════════════════════
// CLIENT PARCELS — paginated
// ═══════════════════════════════════════
async function showClientParcels(ctx, cId, page) {
  try {
    const [clients, allParcels] = await Promise.all([
      sbGet('clients', `?id=eq.${cId}&select=id,name,tg,phone`),
      sbGet('parcels', `?client_id=eq.${cId}&order=date.desc`)
    ]);
    const cl = clients[0];
    if (!cl) return ctx.reply('Клієнта не знайдено');

    const total = allParcels.length;
    const start = page * PAGE_SIZE;
    const slice = allParcels.slice(start, start + PAGE_SIZE);

    const rows = slice.map(p => {
      const st = STATUS[p.status] || { e: '📦', l: p.status };
      return [Markup.button.callback(
        `${st.e} ${p.id} — ${p.shop}`,
        `view_${p.id}`
      )];
    });

    // Pagination
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('« Назад', `cppage_${cId}_${page - 1}`));
    if (start + PAGE_SIZE < total) navRow.push(Markup.button.callback('Далі »', `cppage_${cId}_${page + 1}`));
    if (navRow.length) rows.push(navRow);
    rows.push([Markup.button.callback('« До клієнтів', 'back_clients')]);

    const text = `👤 ${cl.name}${cl.tg ? ' ' + cl.tg : ''}\n📞 ${cl.phone || 'немає'}\n\nПосилок: ${total}\nСторінка ${page + 1} з ${Math.ceil(total / PAGE_SIZE) || 1}:`;

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, Markup.inlineKeyboard(rows));
    } else {
      await ctx.reply(text, Markup.inlineKeyboard(rows));
    }
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
}

bot.action(/^cppage_(\d+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showClientParcels(ctx, parseInt(ctx.match[1]), parseInt(ctx.match[2]));
});

// ═══════════════════════════════════════
// VIEW PARCEL
// ═══════════════════════════════════════
bot.action(/^view_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showParcel(ctx, ctx.match[1]);
});

bot.hears(/^EU-\d+/i, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showParcel(ctx, ctx.message.text.trim().toUpperCase());
});

async function showParcel(ctx, id) {
  try {
    const [parcels, clients, carriers, addresses] = await Promise.all([
      sbGet('parcels', `?id=eq.${id}`),
      sbGet('clients', '?select=id,name,tg'),
      sbGet('carriers', '?select=id,name'),
      sbGet('addresses', '?select=id,name,street,house'),
    ]);
    const p = parcels[0];
    if (!p) return ctx.reply(`Посилку ${id} не знайдено`);

    const text = fmtParcel(p, clients, carriers, addresses);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...parcelActions(p) });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...parcelActions(p) });
    }
  } catch (e) {
    const msg = 'Помилка: ' + e.message;
    if (ctx.callbackQuery) ctx.editMessageText(msg);
    else ctx.reply(msg);
  }
}

// ═══════════════════════════════════════
// PARCEL ACTIONS
// ═══════════════════════════════════════
bot.action(/^next_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Немає доступу');
  const id = ctx.match[1];
  try {
    const parcels = await sbGet('parcels', `?id=eq.${id}`);
    const p = parcels[0];
    if (!p) return ctx.answerCbQuery('Не знайдено');
    const next = getNextStatus(p.status);
    if (!next) return ctx.answerCbQuery('Фінальний статус');
    const upd = { status: next };
    if (next === 'delivered') upd.deliv_date = td();
    await sbPatch('parcels', id, upd);
    await ctx.answerCbQuery(`${STATUS[next].e} ${STATUS[next].l}`);
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('Помилка: ' + e.message); }
});

bot.action(/^pay1_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Немає доступу');
  const id = ctx.match[1];
  try {
    const parcels = await sbGet('parcels', `?id=eq.${id}`);
    const p = parcels[0];
    if (!p) return ctx.answerCbQuery('Не знайдено');
    await sbPatch('parcels', id, { paid1: true });
    const clients = await sbGet('clients', `?id=eq.${p.client_id}&select=name`);
    const cl = clients[0] || { name: '?' };
    await sbPost('transactions', {
      date: td(), type: 'income',
      description: `Оплата послуги ${id}`,
      party: cl.name, parcel_ids: [id],
      amount: p.price, method: 'Переказ'
    });
    await ctx.answerCbQuery(`Оплату €${p.price} зараховано`);
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('Помилка: ' + e.message); }
});

bot.action(/^pay2_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Немає доступу');
  const id = ctx.match[1];
  try {
    const parcels = await sbGet('parcels', `?id=eq.${id}`);
    const p = parcels[0];
    if (!p) return ctx.answerCbQuery('Не знайдено');
    await sbPatch('parcels', id, { paid2: true });
    if (p.ship_cost > 0) {
      const clients = await sbGet('clients', `?id=eq.${p.client_id}&select=name`);
      const cl = clients[0] || { name: '?' };
      await sbPost('transactions', {
        date: td(), type: 'income',
        description: `Оплата перевезення ${id}`,
        party: cl.name, parcel_ids: [id],
        amount: p.ship_cost, method: 'Переказ'
      });
    }
    await ctx.answerCbQuery(`Перевезення оплачено`);
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('Помилка: ' + e.message); }
});

bot.action(/^addship_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  sess(ctx).step = `addship_${id}`;
  await ctx.reply(`Введіть вартість перевезення для ${id} (тільки число, наприклад: 25):`);
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Немає доступу');
  const id = ctx.match[1];
  try {
    await sbPatch('parcels', id, { status: 'cancelled' });
    await ctx.answerCbQuery('Посилку скасовано');
    await showParcel(ctx, id);
  } catch (e) { ctx.answerCbQuery('Помилка: ' + e.message); }
});

// ═══════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════
bot.hears(/Знайти посилку/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showSearchMenu(ctx);
});

async function showSearchMenu(ctx) {
  await ctx.reply('🔍 Знайти посилку:', Markup.inlineKeyboard([
    [Markup.button.callback('📋 Видана адреса',        'srch_issued')],
    [Markup.button.callback('📦 Замовлено (є трек)',   'srch_ordered')],
    [Markup.button.callback('🏪 На відділенні',        'srch_warehouse')],
    [Markup.button.callback('🏠 Отримано на адресі',   'srch_address')],
    [Markup.button.callback('🚐 Передано перевізнику', 'srch_carrier')],
    [Markup.button.callback('📮 Відправлено НП',       'srch_np_sent')],
    [Markup.button.callback('🇺🇦 В UA',                 'srch_ua')],
    [Markup.button.callback('✅ Доставлено',            'srch_delivered')],
    [Markup.button.callback('👑 Легіт',                'srch_legit')],
    [Markup.button.callback('❌ Скасовано',             'srch_cancelled')],
    [Markup.button.callback('🔎 По ID / tracking',     'srch_manual')],
  ]));
}

// Status-based search
bot.action(/^srch_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const key = ctx.match[1];

  if (key === 'manual') {
    s.step = 'search';
    return ctx.editMessageText('Введіть ID посилки (EU-XXXXXX) або tracking номер:');
  }

  try {
    const [parcels, clients, addresses] = await Promise.all([
      sbGet('parcels', `?status=eq.${key}&order=date.desc&limit=30&select=id,client_id,shop,date,status,track,price,ship_cost,paid1,paid2,addr_id,note`),
      sbGet('clients', '?select=id,name,tg'),
      sbGet('addresses', '?select=id,name,street,house'),
    ]);

    if (!parcels.length) {
      return ctx.editMessageText(`Посилок зі статусом "${key}" немає.`, Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'back_main')]]));
    }

    const st = STATUS[key] || { l: key, e: '📦' };
    // Show list of parcels — each as a button
    const rows = parcels.map(p => {
      const cl = clients.find(c => c.id === p.client_id);
      const addr = addresses.find(a => a.id === p.addr_id);
      const addrShort = addr ? ` · ${addr.name}` : '';
      const label = `${p.id} · ${cl ? cl.name : '?'} · ${p.shop || '-'}${addrShort}`;
      return [Markup.button.callback(label.slice(0, 60), `view_${p.id}`)];
    });
    rows.push([Markup.button.callback('« Назад', 'back_main')]);

    await ctx.editMessageText(
      `${st.e} ${st.l} — ${parcels.length} посилок:`,
      Markup.inlineKeyboard(rows)
    );
  } catch(e) { ctx.reply('Помилка: ' + e.message); }
});

// ═══════════════════════════════════════
// REPORT
// ═══════════════════════════════════════
bot.hears(/Звіт/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    const parcels = await sbGet('parcels', '?select=status,date,price,ship_cost,paid1,paid2,client_id');
    const today = new Date().toISOString().split('T')[0];

    const byStatus = {};
    parcels.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });

    const revService = parcels.filter(p => p.paid1).reduce((s, p) => s + (p.price || 0), 0);
    const revShip = parcels.filter(p => p.paid2).reduce((s, p) => s + (p.ship_cost || 0), 0);
    const pendService = parcels.filter(p => !p.paid1 && p.status !== 'cancelled').reduce((s, p) => s + (p.price || 0), 0);
    const pendShip = parcels.filter(p => !p.paid2 && (p.ship_cost || 0) > 0 && p.status !== 'cancelled').reduce((s, p) => s + (p.ship_cost || 0), 0);

    const debtMap = {};
    parcels.filter(p => p.status !== 'cancelled').forEach(p => {
      const owes = (p.paid1 ? 0 : (p.price || 0)) + (p.paid2 ? 0 : (p.ship_cost || 0));
      if (owes > 0) debtMap[p.client_id] = (debtMap[p.client_id] || 0) + owes;
    });

    const statusLines = Object.entries(STATUS)
      .filter(([k]) => byStatus[k])
      .map(([k, v]) => `${v.e} ${v.l}: ${byStatus[k]}`)
      .join('\n');

    const msg = [
      'Зведення EuroPost',
      new Date().toLocaleDateString('uk-UA'),
      '',
      'Посилки:',
      `Всього: ${parcels.length}`,
      statusLines,
      '',
      'Фінанси:',
      `Отримано: €${revService + revShip}`,
      `Очікується послуги: €${pendService}`,
      `Очікується перевезення: €${pendShip}`,
      '',
      `Боржників: ${Object.keys(debtMap).length}`,
    ].join('\n');

    await ctx.reply(msg);
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

// ═══════════════════════════════════════
// DEBTORS
// ═══════════════════════════════════════
bot.hears(/Боржники/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  try {
    const [parcels, clients] = await Promise.all([
      sbGet('parcels', '?status=neq.cancelled&select=client_id,price,ship_cost,paid1,paid2'),
      sbGet('clients', '?select=id,name,tg,phone')
    ]);

    const debtMap = {};
    parcels.forEach(p => {
      const owes = (p.paid1 ? 0 : (p.price || 0)) + (p.paid2 ? 0 : (p.ship_cost || 0));
      if (owes > 0) debtMap[p.client_id] = (debtMap[p.client_id] || 0) + owes;
    });

    const sorted = Object.entries(debtMap).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return ctx.reply('Боржників немає!');

    const total = sorted.reduce((s, [, v]) => s + v, 0);

    // Split into chunks to avoid message length limit
    const lines = [`Боржники: ${sorted.length}`, `Загалом: €${total}`, ''];
    sorted.forEach(([cid, amt]) => {
      const cl = clients.find(c => c.id === parseInt(cid)) || { name: '?' };
      lines.push(`${cl.name} — €${amt}`);
      if (cl.tg || cl.phone) lines.push(`  ${cl.tg || ''} ${cl.phone || ''}`.trim());
      lines.push('');
    });

    // Send in chunks of 30 lines to avoid limit
    const chunk = 30;
    for (let i = 0; i < lines.length; i += chunk) {
      await ctx.reply(lines.slice(i, i + chunk).join('\n'));
    }
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

// ═══════════════════════════════════════
// DIRTY ADDRESSES
// ═══════════════════════════════════════
bot.hears(/Грязні адреси/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply('Грязні адреси:', Markup.inlineKeyboard([
    [Markup.button.callback('➕ Додати запис', 'da_add')],
    [Markup.button.callback('🔍 Перевірити адресу', 'da_check')],
    [Markup.button.callback('📋 Останні 10 записів', 'da_list')],
    [Markup.button.callback('« Назад', 'back_main')],
  ]));
});

bot.action('da_add', async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).step = 'dirty_addr';
  sess(ctx).newDirty = {};
  await ctx.editMessageText('Введіть адресу (наприклад: Maria Basov Breslauer Strasse 44a):');
});

bot.action('da_check', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    // Show list of all unique addresses as buttons
    const records = await sbGet('dirty_addresses', '?select=addr&order=addr');
    const unique = [...new Set(records.map(r => r.addr))].slice(0, 40);

    if (!unique.length) return ctx.editMessageText('Записів немає');

    const rows = unique.map(addr =>
      [Markup.button.callback(addr.substring(0, 60), `dcheck_${encodeAddr(addr)}`)]
    );
    rows.push([Markup.button.callback('« Назад', 'da_back')]);

    await ctx.editMessageText('Виберіть адресу для перевірки:', Markup.inlineKeyboard(rows));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

bot.action('da_back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Грязні адреси:', Markup.inlineKeyboard([
    [Markup.button.callback('➕ Додати запис', 'da_add')],
    [Markup.button.callback('🔍 Перевірити адресу', 'da_check')],
    [Markup.button.callback('📋 Останні 10 записів', 'da_list')],
    [Markup.button.callback('« Назад', 'back_main')],
  ]));
});

// Encode addr for callback (max 64 bytes total in callback_data)
function encodeAddr(addr) {
  return Buffer.from(addr).toString('base64').substring(0, 40);
}

// Store addr map in memory for lookups
const addrCache = {};

bot.action('da_check', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const records = await sbGet('dirty_addresses', '?select=addr&order=addr');
    const unique = [...new Set(records.map(r => r.addr))].slice(0, 30);
    if (!unique.length) return ctx.editMessageText('Записів немає');

    const rows = unique.map((addr, i) => {
      const key = `da${i}`;
      addrCache[key] = addr;
      return [Markup.button.callback(addr.substring(0, 55), `dcheck_${key}`)];
    });
    rows.push([Markup.button.callback('« Назад', 'da_back')]);
    await ctx.editMessageText('Виберіть адресу:', Markup.inlineKeyboard(rows));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

bot.action(/^dcheck_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const key = ctx.match[1];
  const addr = addrCache[key];
  if (!addr) return ctx.editMessageText('Адресу не знайдено, спробуйте ще раз');

  try {
    const records = await sbGet('dirty_addresses', `?addr=eq.${encodeURIComponent(addr)}&order=date.desc`);
    if (!records.length) {
      return ctx.editMessageText(`Адреса: ${addr}\n\nЗаписів немає — адреса вільна!`,
        Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'da_check')]]));
    }

    const lines = [`Адреса: ${addr}`, `Знайдено записів: ${records.length}`, ''];
    records.forEach(r => {
      lines.push(`${r.shop} — ${r.tg || 'без TG'} — ${r.method || ''} — ${r.date || ''}`);
    });

    await ctx.editMessageText(lines.join('\n'),
      Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'da_check')]]));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

bot.action('da_list', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const records = await sbGet('dirty_addresses', '?order=id.desc&limit=10');
    if (!records.length) return ctx.editMessageText('Записів немає');

    const lines = ['Останні 10 записів:', ''];
    records.forEach(r => {
      lines.push(`${r.addr}`);
      lines.push(`  ${r.shop} — ${r.tg || 'без TG'} — ${r.method || ''} — ${r.date || ''}`);
      lines.push('');
    });

    await ctx.editMessageText(lines.join('\n'),
      Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'da_back')]]));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

// ═══════════════════════════════════════
// ADD PARCEL — dialog
// ═══════════════════════════════════════
bot.hears(/Нова посилка/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const s = sess(ctx);
  s.step = 'parcel_client';
  s.newParcel = {};

  try {
    const clients = await sbGet('clients', '?status=neq.inactive&select=id,name,tg&order=name');
    s.clients = clients;

    const rows = clients.slice(0, 20).map(c =>
      [Markup.button.callback(c.name + (c.tg ? ' ' + c.tg : ''), `nc_${c.id}`)]
    );
    rows.push([Markup.button.callback('« Скасувати', 'back_main')]);
    await ctx.reply('Оберіть клієнта:', Markup.inlineKeyboard(rows));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

bot.action(/^nc_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.newParcel.client_id = parseInt(ctx.match[1]);
  s.step = 'parcel_addr';

  try {
    const addrs = await sbGet('addresses', '?status=eq.free&select=id,name,street,house,city');
    const rows = addrs.map(a =>
      [Markup.button.callback(`${a.name} — ${a.street} ${a.house}, ${a.city}`, `na_${a.id}`)]
    );
    rows.push([Markup.button.callback('« Назад', 'back_main')]);
    await ctx.editMessageText('Оберіть адресу ЄС:', Markup.inlineKeyboard(rows));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

bot.action(/^na_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).newParcel.addr_id = parseInt(ctx.match[1]);
  sess(ctx).step = 'parcel_shop';

  const shops = ['Amazon','Aliexpress','About You','Zalando','H&M','Zara','eBay','ASOS','Shein','Otto'];
  const rows = [];
  for (let i = 0; i < shops.length; i += 3) {
    rows.push(shops.slice(i, i+3).map(s => Markup.button.callback(s, `ns_${s}`)));
  }
  rows.push([Markup.button.callback('✏ Інший магазин', 'ns_other')]);
  rows.push([Markup.button.callback('« Назад', 'back_main')]);
  await ctx.editMessageText('Оберіть магазин:', Markup.inlineKeyboard(rows));
});

bot.action(/^ns_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const shop = ctx.match[1];
  if (shop === 'other') {
    sess(ctx).step = 'parcel_shop_text';
    return ctx.editMessageText('Введіть назву магазину:');
  }
  sess(ctx).newParcel.shop = shop;
  sess(ctx).step = 'parcel_track';
  await ctx.editMessageText(`Магазин: ${shop}\n\nВведіть tracking номер (або /skip):`);
});

// ═══════════════════════════════════════
// TEXT HANDLER
// ═══════════════════════════════════════
bot.on('text', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const s = sess(ctx);
  const text = ctx.message.text.trim();
  if (text.startsWith('/') && text !== '/skip') return;

  // Quick search by parcel ID
  if (/^EU-\d+$/i.test(text)) {
    return showParcel(ctx, text.toUpperCase());
  }

  // ── KEYBOARD BUTTONS ──
  if (/Видати адресу/i.test(text)) return startIssueAddr(ctx);
  if (/Нова посилка/i.test(text)) {
    s.step = null;
    // redirect to hears handler logic inline
    try {
      const clients = await sbGet('clients', '?order=name&select=id,name');
      if (!clients.length) return ctx.reply('Немає клієнтів');
      const rows = clients.map(c => [Markup.button.callback(c.name, `nc_${c.id}`)]);
      rows.push([Markup.button.callback('« Назад', 'back_main')]);
      return ctx.reply('Оберіть клієнта:', Markup.inlineKeyboard(rows));
    } catch(e) { return ctx.reply('Помилка: ' + e.message); }
  }
  if (/Клієнти/i.test(text) && !/Новий клієнт/i.test(text)) {
    // redirect to clients handler
    try {
      const clients = await sbGet('clients', '?order=name&select=id,name,tg,balance,status');
      if (!clients.length) return ctx.reply('Клієнтів немає');
      const active = clients.filter(c => c.status !== 'inactive');
      const rows = active.map(c => {
        const debt = (c.balance || 0) < 0 ? ' 🔴' : '';
        return [Markup.button.callback(c.name + debt, `cl_${c.id}`)];
      });
      rows.push([Markup.button.callback('« Назад', 'back_main')]);
      return ctx.reply(`Клієнти (${active.length}):`, Markup.inlineKeyboard(rows));
    } catch(e) { return ctx.reply('Помилка: ' + e.message); }
  }
  if (/Новий клієнт/i.test(text)) {
    s.step = 'client_name';
    s.newClient = {};
    return ctx.reply("Новий клієнт\n\nВведіть ім'я:");
  }
  if (/Знайти посилку/i.test(text)) {
    return showSearchMenu(ctx);
  }
  if (/Грязні адреси/i.test(text)) {
    return ctx.reply('🗂 Грязні адреси:', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Додати запис', 'da_add')],
      [Markup.button.callback('🔍 Перевірити адресу', 'da_check')],
      [Markup.button.callback('📋 Останні 10', 'da_list')],
      [Markup.button.callback('« Назад', 'back_main')],
    ]));
  }

  // ── ADD SHIP COST ──
  if (s.step && s.step.startsWith('addship_')) {
    const id = s.step.replace('addship_', '');
    const cost = parseFloat(text.replace(',', '.'));
    if (isNaN(cost)) return ctx.reply('Введіть число, наприклад: 25');
    try {
      await sbPatch('parcels', id, { ship_cost: cost }, 'id');
      s.step = null;
      await ctx.reply(`Вартість перевезення €${cost} встановлено для ${id}`);
      await showParcel(ctx, id);
    } catch (e) { ctx.reply('Помилка: ' + e.message); }
    return;
  }

  // ── ADD CLIENT DIALOG ──
  if (s.step === 'client_name') {
    s.newClient.name = text;
    s.step = 'client_phone';
    return ctx.reply(`Клієнт: ${text}\n\nВведіть телефон:`);
  }
  if (s.step === 'client_phone') {
    s.newClient.phone = text === '/skip' ? '' : text;
    s.step = 'client_tg';
    return ctx.reply('Telegram username (або /skip):');
  }
  if (s.step === 'client_tg') {
    let tg = text === '/skip' ? '' : text;
    if (tg && !tg.startsWith('@')) tg = '@' + tg;
    s.newClient.tg = tg;
    s.step = 'client_city';
    return ctx.reply('Місто в Україні (або /skip):');
  }
  if (s.step === 'client_city') {
    s.newClient.city = text === '/skip' ? '' : text;
    s.step = 'client_np';
    return ctx.reply('Відділення Нової Пошти (або /skip):');
  }
  if (s.step === 'client_np') {
    s.newClient.np = text === '/skip' ? '' : text;
    // Save client
    try {
      const data = {
        ...s.newClient,
        status: 'active',
        balance: 0,
        email: '',
        addr: '',
      };
      const res = await sbPost('clients', data);
      const newId = (res[0] || {}).id || '?';
      s.step = null;
      s.newClient = {};
      const lines = [
        `Клієнта додано!`,
        ``,
        `Імя: ${data.name}`,
        `Телефон: ${data.phone || 'немає'}`,
        `Telegram: ${data.tg || 'немає'}`,
        `Місто: ${data.city || 'немає'}`,
        `НП: ${data.np || 'немає'}`,
      ];
      await ctx.reply(lines.join('\n'), mainMenu());
    } catch (e) {
      ctx.reply('Помилка збереження: ' + e.message);
    }
    return;
  }

  // ── ISSUE ADDR TEXT ──
  if (s.step === 'ia_shop_manual') {
    sess(ctx).ia.shop = text;
    s.step = null;
    await iaShowAddresses(ctx);
    return;
  }
  if (s.step === 'ia_shop_search') {
    s.step = null;
    s.ia.shopFilter = text;
    s.ia.shopPage = 0;
    await iaShowShopMenu(ctx, text);
    return;
  }
  if (s.step === 'ia2_shops') {
    s.ia.shops = s.ia.shops || [];
    const shop = text.trim();
    if (s.ia.shops.includes(shop)) {
      await ctx.reply('⚠️ ' + shop + ' вже є в списку');
    } else {
      s.ia.shops.push(shop);
      const list = s.ia.shops.map((s,i) => (i+1)+'. 🏪 '+s).join('\n');
      await ctx.reply('Список магазинів ('+s.ia.shops.length+'):\n'+list, Markup.inlineKeyboard([
        [Markup.button.callback('✔ Готово →', 'ia2_shops_done')],
        [Markup.button.callback('❌ Видалити останній', 'ia2_shop_remove')],
        [Markup.button.callback('« Скасувати', 'back_main')],
      ]));
    }
    return;
  }
  if (s.step === 'ia_note') {
    s.step = null;
    await iaFinalize(ctx, text === '/skip' ? '' : text);
    return;
  }
  if (s.step === 'ia2_note') {
    s.step = null;
    await iaFinalize2(ctx, text === '/skip' ? '' : text);
    return;
  }

  // ── SEARCH ──
  if (s.step === 'search') {
    s.step = null;
    try {
      let parcels = [];
      if (text.toUpperCase().startsWith('EU-')) {
        parcels = await sbGet('parcels', `?id=eq.${text.toUpperCase()}`);
      } else {
        parcels = await sbGet('parcels', `?track=eq.${text}`);
      }
      if (!parcels.length) return ctx.reply(`Нічого не знайдено: ${text}`);
      const [clients, carriers, addresses] = await Promise.all([
        sbGet('clients', '?select=id,name,tg'),
        sbGet('carriers', '?select=id,name'),
        sbGet('addresses', '?select=id,name,street,house')
      ]);
      const p = parcels[0];
      await ctx.reply(fmtParcel(p, clients, carriers, addresses), { parse_mode: 'Markdown', ...parcelActions(p) });
    } catch (e) { ctx.reply('Помилка: ' + e.message); }
    return;
  }

  // ── PARCEL DIALOG ──
  if (s.step === 'parcel_shop_text') {
    s.newParcel.shop = text;
    s.step = 'parcel_track';
    return ctx.reply(`Магазин: ${text}\n\nВведіть tracking номер (або /skip):`);
  }
  if (s.step === 'parcel_track') {
    s.newParcel.track = text === '/skip' ? null : text;
    s.step = 'parcel_price';
    return ctx.reply('Вартість послуги €? (тільки число):');
  }
  if (s.step === 'parcel_price') {
    const price = parseFloat(text.replace(',', '.'));
    if (isNaN(price)) return ctx.reply('Введіть число, наприклад: 35');
    s.newParcel.price = price;
    s.step = 'parcel_ship';
    return ctx.reply('Вартість перевезення € (або /skip):');
  }
  if (s.step === 'parcel_ship') {
    s.newParcel.ship_cost = text === '/skip' ? 0 : (parseFloat(text.replace(',', '.')) || 0);
    s.step = 'parcel_note';
    return ctx.reply('Примітка (або /skip):');
  }
  if (s.step === 'parcel_note') {
    s.newParcel.note = text === '/skip' ? null : text;
    try {
      const newId = 'EU-' + String(Date.now()).slice(-6);
      const data = { id: newId, ...s.newParcel, date: td(), status: 'issued', paid1: false, paid2: false };
      await sbPost('parcels', data);
      s.step = null;
      s.newParcel = {};
      await ctx.reply(`Посилку ${newId} створено!\n\nМагазин: ${data.shop}\nПослуга: €${data.price}\nПеревезення: €${data.ship_cost || 0}`, mainMenu());
    } catch (e) { ctx.reply('Помилка збереження: ' + e.message); }
    return;
  }

  // ── DIRTY ADDRESS DIALOG ──
  if (s.step === 'dirty_addr') {
    s.newDirty = { addr: text };
    s.step = 'dirty_shop';
    const shops = ['Amazon','Aliexpress','About You','Zalando','H&M','Zara','ASOS','Shein'];
    const rows = [];
    for (let i = 0; i < shops.length; i += 3) {
      rows.push(shops.slice(i, i+3).map(sh => Markup.button.callback(sh, `ds_${sh}`)));
    }
    rows.push([Markup.button.callback('✏ Інший', 'ds_other')]);
    return ctx.reply('Магазин:', Markup.inlineKeyboard(rows));
  }
  if (s.step === 'dirty_shop_text') {
    s.newDirty.shop = text;
    s.step = 'dirty_tg';
    return ctx.reply('Telegram замовника (або /skip):');
  }
  if (s.step === 'dirty_tg') {
    s.newDirty.tg = text === '/skip' ? '' : (text.startsWith('@') ? text : '@' + text);
    s.step = 'dirty_method';
    return ctx.reply('Метод:', Markup.inlineKeyboard([
      [Markup.button.callback('FTID', 'dm_FTID'), Markup.button.callback('RTS', 'dm_RTS')],
      [Markup.button.callback('DAMAGE', 'dm_DAMAGE'), Markup.button.callback('DNA', 'dm_DNA')],
    ]));
  }
});

// Dirty shop/method callbacks
bot.action(/^ds_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const val = ctx.match[1];
  const s = sess(ctx);
  if (val === 'other') {
    s.step = 'dirty_shop_text';
    return ctx.editMessageText('Введіть назву магазину:');
  }
  s.newDirty.shop = val;
  s.step = 'dirty_tg';
  await ctx.editMessageText(`Магазин: ${val}\n\nTelegram замовника (або /skip):`);
});

bot.action(/^dm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.newDirty.method = ctx.match[1];
  try {
    const data = { ...s.newDirty, date: new Date().toLocaleDateString('uk-UA') };
    await sbPost('dirty_addresses', data);
    s.step = null;
    s.newDirty = {};
    await ctx.editMessageText(`Запис додано!\n\nАдреса: ${data.addr}\nМагазин: ${data.shop}\nTG: ${data.tg || 'немає'}\nМетод: ${data.method}`);
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});




// ═══════════════════════════════════════
// ISSUE ADDRESS — бот
// ═══════════════════════════════════════

// Entry point — callback button from main menu
bot.action('issue_addr', async (ctx) => {
  await ctx.answerCbQuery();
  await startIssueAddr(ctx);
});

// Also via keyboard button (regex match)
bot.hears(/Видати адресу/i, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await startIssueAddr(ctx);
});

async function startIssueAddr(ctx) {
  sess(ctx).ia = {};
  await ctx.reply(
    '📍 Видати адресу\n\nОберіть режим:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 1 магазин → N адрес', 'ia_mode_1')],
      [Markup.button.callback('🏪 1 адреса → N магазинів', 'ia_mode_2')],
      [Markup.button.callback('« Назад', 'back_main')],
    ])
  );
}

// Mode selection
bot.action('ia_mode_1', async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).ia.mode = 1;
  await iaLoadClients(ctx, 'ia_cl_');
});

bot.action('ia_mode_2', async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).ia.mode = 2;
  sess(ctx).ia.shops = [];
  await iaLoadClients(ctx, 'ia2_cl_');
});

async function iaLoadClients(ctx, prefix) {
  const clients = await sbGet('clients', '?status=neq.inactive&select=id,name,tg&order=name');
  if (!clients.length) return ctx.reply('Немає клієнтів в базі');
  const rows = clients.map(c => [Markup.button.callback(c.name + (c.tg?' '+c.tg:''), prefix+c.id)]);
  rows.push([Markup.button.callback('« Назад', 'back_main')]);
  await ctx.editMessageText('📍 Крок 1 — Оберіть клієнта:', Markup.inlineKeyboard(rows));
}

// Mode 2 — client selected → enter shops first
bot.action(/^ia2_cl_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const cId = parseInt(ctx.match[1]);
  const clients = await sbGet('clients', `?id=eq.${cId}&select=id,name,tg`);
  const cl = clients[0];
  s.ia.client_id = cId; s.ia.clientName = cl.name; s.ia.clientTg = cl.tg||'';
  s.ia.shops = [];
  s.step = 'ia2_shops';
  await ctx.editMessageText(
    `👤 ${cl.name}\n\nКрок 2 — Введіть магазини по одному.\nКожне повідомлення = 1 магазин.\nСистема знайде адресу чисту для ВСІХ.\n\nСписок: (поки порожній)`,
    Markup.inlineKeyboard([
      [Markup.button.callback('« Скасувати', 'back_main')],
    ])
  );
});

// Step 1 — client selected → show shops
bot.action(/^ia_cl_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const cId = parseInt(ctx.match[1]);
  try {
    const clients = await sbGet('clients', `?id=eq.${cId}&select=id,name,tg`);
    const cl = clients[0];
    s.ia = { client_id: cId, clientName: cl.name, clientTg: cl.tg || '' };

    // Get unique shops from parcels + dirty_addresses
    const [parcels, dirty] = await Promise.all([
      sbGet('parcels', '?select=shop'),
      sbGet('dirty_addresses', '?select=shop'),
    ]);
    const shopSet = new Set();
    [...parcels, ...dirty].forEach(r => { if(r.shop) shopSet.add(r.shop.trim()); });
    const shops = [...shopSet].sort();

    s.ia.shopList = shops;
    s.ia.shopPage = 0;
    s.step = null;
    await iaShowShopMenu(ctx);
  } catch(e) { ctx.reply('Помилка: ' + e.message); }
});

async function iaShowShopMenu(ctx, filter = '') {
  const s = sess(ctx);
  const cl = s.ia.clientObj || {};
  const shops = s.ia.shopList || [];
  const PAGE = 16;
  const page = s.ia.shopPage || 0;

  let filtered = filter
    ? shops.filter(sh => sh.toLowerCase().includes(filter.toLowerCase()))
    : shops;

  // If search found nothing — show similar (Levenshtein-ish: common chars)
  let isApprox = false;
  if (filter && !filtered.length) {
    isApprox = true;
    const fl = filter.toLowerCase();
    filtered = shops.filter(sh => {
      const sl = sh.toLowerCase();
      // Check if at least half the filter chars appear in shop name
      let hits = 0;
      for (const ch of fl) if (sl.includes(ch)) hits++;
      return hits >= Math.ceil(fl.length * 0.5);
    }).slice(0, 8);
  }

  const total = filtered.length;
  const page_shops = filtered.slice(page * PAGE, (page + 1) * PAGE);

  const rows = [];
  for (let i = 0; i < page_shops.length; i += 2) {
    const globalIdx = shops.indexOf(page_shops[i]);
    const row = [Markup.button.callback(page_shops[i], `ia_sh_${globalIdx}`)];
    if (page_shops[i+1]) {
      const globalIdx2 = shops.indexOf(page_shops[i+1]);
      row.push(Markup.button.callback(page_shops[i+1], `ia_sh_${globalIdx2}`));
    }
    rows.push(row);
  }

  // Pagination
  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback('◀ Назад', 'ia_sh_page_prev'));
  if ((page + 1) * PAGE < total) navRow.push(Markup.button.callback('▶ Далі', 'ia_sh_page_next'));
  if (navRow.length) rows.push(navRow);

  rows.push([Markup.button.callback('🔎 Пошук магазину', 'ia_sh_search')]);
  rows.push([Markup.button.callback('✏ Інший магазин', 'ia_sh_new')]);
  rows.push([Markup.button.callback('« Назад', 'back_main')]);

  const header = filter
    ? (isApprox
      ? `🔍 Схожі на "${filter}" (${total}):\n\nКрок 2 — Оберіть або введіть інший:`
      : `🔍 Результат для "${filter}" (${total}):\n\nКрок 2 — Оберіть магазин:`)
    : `👤 ${s.ia.clientName}\n\nКрок 2 — Оберіть магазин (${total}):`;

  try {
    if (ctx.callbackQuery) await ctx.editMessageText(header, Markup.inlineKeyboard(rows));
    else await ctx.reply(header, Markup.inlineKeyboard(rows));
  } catch(e) { await ctx.reply(header, Markup.inlineKeyboard(rows)); }
}

// Shop selected from list
bot.action(/^ia_sh_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const idx = parseInt(ctx.match[1]);
  const shop = (s.ia.shopList || [])[idx];
  if (!shop) return ctx.reply('Помилка: магазин не знайдено');
  s.ia.shop = shop;
  await iaShowAddresses(ctx);
});

// Pagination
bot.action('ia_sh_page_prev', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.ia.shopPage = Math.max(0, (s.ia.shopPage || 0) - 1);
  await iaShowShopMenu(ctx, s.ia.shopFilter || '');
});
bot.action('ia_sh_page_next', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.ia.shopPage = (s.ia.shopPage || 0) + 1;
  await iaShowShopMenu(ctx, s.ia.shopFilter || '');
});

// Search button
bot.action('ia_sh_search', async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).step = 'ia_shop_search';
  await ctx.editMessageText('Введіть назву магазину для пошуку:');
});

// Manual shop input
bot.action('ia_sh_new', async (ctx) => {
  await ctx.answerCbQuery();
  sess(ctx).step = 'ia_shop_manual';
  await ctx.editMessageText('Введіть назву магазину:');
});

// Step 3 — show free addresses for this shop (multi-select)
async function iaShowAddresses(ctx) {
  const s = sess(ctx);
  try {
    const [allAddrs, allDirty] = await Promise.all([
      sbGet('addresses', '?order=name&select=id,name,street,house,zip,city,country,phone,door,status'),
      sbGet('dirty_addresses', '?select=addr,shop'),
    ]);

    const shopLower = (s.ia.shop || '').trim().toLowerCase();
    const usedSet = new Set(
      allDirty
        .filter(d => (d.shop || '').trim().toLowerCase() === shopLower)
        .map(d => (d.addr || '').trim().toLowerCase())
    );

    const free = allAddrs.filter(a => {
      const key = (a.name + ' ' + a.street + ' ' + a.house).trim().toLowerCase();
      return a.status === 'free' && !usedSet.has(key);
    });

    s.ia.freeAddrs = free;
    s.ia.selectedAddrs = s.ia.selectedAddrs || [];

    if (!free.length) {
      const text = `🏪 ${s.ia.shop}\n\n⚠️ Всі адреси вже використані для цього магазину!`;
      if (ctx.callbackQuery) await ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'back_main')]]));
      else await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'back_main')]]));
      return;
    }

    await iaSendAddrList(ctx);
  } catch(e) { ctx.reply('Помилка: ' + e.message); }
}

async function iaSendAddrList(ctx) {
  const s = sess(ctx);
  const free = s.ia.freeAddrs;
  const selected = s.ia.selectedAddrs;

  const rows = free.map(a => {
    const isSel = selected.includes(a.id);
    const label = (isSel ? '✅ ' : '☐ ') + a.name + ' — ' + a.street + ' ' + a.house;
    return [Markup.button.callback(label, `ia_ad_${a.id}`)];
  });

  const selCount = selected.length;
  if (selCount > 0) {
    rows.push([Markup.button.callback(`✔ Далі (${selCount} обрано) →`, 'ia_addr_done')]);
  }
  rows.push([Markup.button.callback('« Назад', 'back_main')]);

  const text = `👤 ${s.ia.clientName}\n🏪 ${s.ia.shop}\n\n✅ Вільних: ${free.length} адрес\n${selCount ? '☑ Обрано: ' + selCount : ''}\n\nКрок 3 — Оберіть адреси (можна кілька):`;
  try {
    if (ctx.callbackQuery) await ctx.editMessageText(text, Markup.inlineKeyboard(rows));
    else await ctx.reply(text, Markup.inlineKeyboard(rows));
  } catch(e) { await ctx.reply(text, Markup.inlineKeyboard(rows)); }
}

// Toggle address selection
bot.action(/^ia_ad_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const aId = parseInt(ctx.match[1]);
  s.ia.selectedAddrs = s.ia.selectedAddrs || [];
  const idx = s.ia.selectedAddrs.indexOf(aId);
  if (idx === -1) s.ia.selectedAddrs.push(aId);
  else s.ia.selectedAddrs.splice(idx, 1);
  await iaSendAddrList(ctx);
});

// Done selecting addresses → go to method
bot.action('ia_addr_done', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  if (!s.ia.selectedAddrs.length) return ctx.answerCbQuery('Оберіть хоча б одну адресу');
  const cnt = s.ia.selectedAddrs.length;
  await ctx.editMessageText(
    `👤 ${s.ia.clientName}\n🏪 ${s.ia.shop}\n📍 Обрано адрес: ${cnt}\n\nКрок 4 — Оберіть метод:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('FTID', 'ia_mt_FTID'), Markup.button.callback('RTS', 'ia_mt_RTS')],
      [Markup.button.callback('DAMAGE', 'ia_mt_DAMAGE'), Markup.button.callback('DNA', 'ia_mt_DNA')],
      [Markup.button.callback('Зберігаємо', 'ia_mt_Зберігаємо')],
      [Markup.button.callback('« Назад', 'back_main')],
    ])
  );
});

// Method selected → ask note
bot.action(/^ia_mt_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.ia.method = ctx.match[1];
  s.step = 'ia_note';
  await ctx.editMessageText(
    `👤 ${s.ia.clientName}\n🏪 ${s.ia.shop}\n📋 ${s.ia.method}\n\nКрок 5 — Примітка (або /skip):`
  );
});

// Mode 2 — remove last shop
bot.action('ia2_shop_remove', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.ia.shops = s.ia.shops || [];
  if (s.ia.shops.length) s.ia.shops.pop();
  const list = s.ia.shops.length ? s.ia.shops.map((sh,i)=>(i+1)+'. 🏪 '+sh).join('\n') : '(порожній)';
  await ctx.editMessageText('Список магазинів ('+s.ia.shops.length+'):\n'+list, Markup.inlineKeyboard([
    [Markup.button.callback('✔ Готово →','ia2_shops_done')],
    [Markup.button.callback('❌ Видалити останній','ia2_shop_remove')],
    [Markup.button.callback('« Скасувати','back_main')],
  ]));
});

// Mode 2 — shops done → find matching addresses
bot.action('ia2_shops_done', async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  if (!s.ia.shops || !s.ia.shops.length) return ctx.answerCbQuery('Додайте хоча б один магазин!');
  s.step = null;

  try {
    const [allAddrs, allDirty] = await Promise.all([
      sbGet('addresses', '?status=eq.free&order=name&select=id,name,street,house,zip,city,country,phone,door'),
      sbGet('dirty_addresses', '?select=addr,shop'),
    ]);

    // Find addresses clean for ALL shops simultaneously
    const matching = allAddrs.filter(a => {
      const addrKey = (a.name + ' ' + a.street + ' ' + a.house).trim().toLowerCase();
      return s.ia.shops.every(shop => {
        const shopLow = shop.trim().toLowerCase();
        return !allDirty.some(d =>
          (d.addr||'').trim().toLowerCase() === addrKey &&
          (d.shop||'').trim().toLowerCase() === shopLow
        );
      });
    });

    if (!matching.length) {
      return ctx.editMessageText(
        `⚠️ Немає адреси чистої для всіх ${s.ia.shops.length} магазинів одночасно!\n\nСпробуй зменшити список.`,
        Markup.inlineKeyboard([[Markup.button.callback('« Назад','back_main')]])
      );
    }

    s.ia.matchingAddrs = matching;
    const rows = matching.map(a => [Markup.button.callback(
      a.name + ' — ' + a.street + ' ' + a.house + ', ' + a.city, `ia2_ad_${a.id}`
    )]);
    rows.push([Markup.button.callback('« Назад','back_main')]);

    await ctx.editMessageText(
      `✅ Підходить для всіх ${s.ia.shops.length} магазинів: ${matching.length} адрес\n\nКрок 3 — Оберіть адресу:`,
      Markup.inlineKeyboard(rows)
    );
  } catch(e) { ctx.reply('Помилка: ' + e.message); }
});

// Mode 2 — address selected from smart search → method
bot.action(/^ia2_ad_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const aId = parseInt(ctx.match[1]);
  s.ia.addrId = aId;
  s.ia.addrObj = (s.ia.matchingAddrs||[]).find(a=>a.id===aId);
  if (!s.ia.addrObj) return ctx.reply('Адресу не знайдено');
  const a = s.ia.addrObj;
  await ctx.editMessageText(
    `👤 ${s.ia.clientName}\n📍 ${a.name} — ${a.street} ${a.house}, ${a.city}\n🏪 Магазинів: ${s.ia.shops.length}\n\nКрок 4 — Оберіть метод:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('FTID','ia2_mt_FTID'), Markup.button.callback('RTS','ia2_mt_RTS')],
      [Markup.button.callback('DAMAGE','ia2_mt_DAMAGE'), Markup.button.callback('DNA','ia2_mt_DNA')],
      [Markup.button.callback('Зберігаємо','ia2_mt_Зберігаємо')],
      [Markup.button.callback('« Назад','back_main')],
    ])
  );
});

// Mode 2 — method selected → note
bot.action(/^ia2_mt_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  s.ia.method = ctx.match[1];
  s.step = 'ia2_note';
  await ctx.editMessageText(`📋 Метод: ${s.ia.method}\n\nПримітка (або /skip):`);
});

// Finalize — save everything
async function iaFinalize(ctx, note) {
  const s = sess(ctx);
  const ia = s.ia;
  const today = new Date().toLocaleDateString('uk-UA');
  const todayISO = new Date().toISOString().split('T')[0];
  const created = [];

  try {
    for (const addrId of (ia.selectedAddrs || [])) {
      const a = (ia.freeAddrs || []).find(x => x.id === addrId);
      if (!a) continue;

      await sbPost('dirty_addresses', {
        addr: a.name + ' ' + a.street + ' ' + a.house,
        shop: ia.shop, tg: ia.clientTg,
        date: today, method: ia.method, note: note || '',
      });

      await new Promise(r => setTimeout(r, 5));
      const newId = 'EU-' + String(Date.now()).slice(-6);
      await sbPost('parcels', {
        id: newId, client_id: ia.client_id, addr_id: addrId,
        shop: ia.shop, date: todayISO, status: 'issued',
        price: 0, ship_cost: 0, paid1: false, paid2: false, note: note || '',
      });
      created.push({ id: newId, addr: a });
    }

    const lines = [
      '✅ Видано ' + created.length + ' адрес!',
      '',
      '👤 ' + ia.clientName + (ia.clientTg ? ' ' + ia.clientTg : ''),
      '🏪 ' + ia.shop,
      '📋 ' + ia.method,
      note ? '📝 ' + note : null,
      '',
    ];
    created.forEach((c, i) => {
      const a = c.addr;
      lines.push('─── ' + c.id + ' ───');
      lines.push(a.name);
      lines.push(a.street + ' ' + a.house + (a.door ? ', ' + a.door : ''));
      lines.push((a.zip || '') + ' ' + (a.city || ''));
      if (a.phone) lines.push('Tel: ' + a.phone);
      lines.push('');
    });

    s.ia = {};
    s.step = null;
    await ctx.reply(lines.filter(l => l !== null).join('\n'), mainMenu());
  } catch(e) {
    ctx.reply('Помилка: ' + e.message);
  }
}

async function iaFinalize2(ctx, note) {
  const s = sess(ctx);
  const ia = s.ia;
  const a = ia.addrObj;
  const today = new Date().toLocaleDateString('uk-UA');
  const todayISO = new Date().toISOString().split('T')[0];
  const addrKey = a.name + ' ' + a.street + ' ' + a.house;
  const created = [];

  try {
    for (const shop of (ia.shops || [])) {
      await sbPost('dirty_addresses', {
        addr: addrKey, shop, tg: ia.clientTg,
        date: today, method: ia.method, note: note||'',
      });
      await new Promise(r => setTimeout(r, 5));
      const newId = 'EU-' + String(Date.now()).slice(-6);
      await sbPost('parcels', {
        id: newId, client_id: ia.client_id, addr_id: ia.addrId,
        shop, date: todayISO, status: 'issued',
        price: 0, ship_cost: 0, paid1: false, paid2: false, note: note||'',
      });
      created.push({ id: newId, shop });
    }

    const lines = [
      '✅ Видано ' + created.length + ' посилок!',
      '',
      '👤 ' + ia.clientName + (ia.clientTg?' '+ia.clientTg:''),
      '📍 ' + addrKey + ', ' + (a.zip||'') + ' ' + (a.city||''),
      a.phone ? 'Tel: ' + a.phone : null,
      '📋 ' + ia.method,
      note ? '📝 ' + note : null,
      '',
    ];
    created.forEach(c => lines.push('• ' + c.id + ' — ' + c.shop));

    s.ia = {}; s.step = null;
    await ctx.reply(lines.filter(l=>l!==null).join('\n'), mainMenu());
  } catch(e) { ctx.reply('Помилка: ' + e.message); }
}

// ═══════════════════════════════════════
// MORNING REPORT
// ═══════════════════════════════════════
async function sendMorningReport() {
  if (!ADMIN_IDS.length) return;
  try {
    const [toPickup, addresses] = await Promise.all([
      sbGet('parcels', '?status=eq.warehouse&select=id,client_id,shop,track,note,addr_id,description'),
      sbGet('addresses', '?select=id,name'),
    ]);

    const today = new Date().toLocaleDateString('uk-UA');

    if (!toPickup.length) {
      for (const adminId of ADMIN_IDS) {
        await bot.telegram.sendMessage(adminId,
          `☀️ Доброго ранку! ${today}\n\n✅ Посилок на відділенні немає!`
        );
      }
      return;
    }

    const lines = [
      `☀️ Доброго ранку! ${today}`,
      `🏪 Потрібно забрати з відділення (${toPickup.length}):`,
      '',
    ];

    toPickup.forEach((p, i) => {
      const addr = addresses.find(a => a.id === p.addr_id);
      lines.push(`${i + 1}. Адреса: ${addr ? addr.name : '—'}`);
      lines.push(`   Трек: ${p.track || '—'}`);
      lines.push(`   Товар: ${p.description || p.note || '—'}`);
      lines.push(`   Магазин: ${p.shop || '—'}`);
      lines.push('');
    });

    for (const adminId of ADMIN_IDS) {
      await bot.telegram.sendMessage(adminId, lines.join('\n'));
    }
  } catch (e) { console.error('Morning report error:', e.message); }
}

function scheduleMorning() {
  function msUntilNext() {
    const now = new Date();
    // Kyiv: UTC+2 winter, UTC+3 summer
    const kyivOffsetMs = (now.getTimezoneOffset() < 0 ? 0 : 1) ? 2 * 3600000 : 3 * 3600000;
    // Simpler: just use fixed UTC+2 (safe for server in UTC)
    // 10:00 Kyiv = 08:00 UTC (winter) or 07:00 UTC (summer)
    // Check DST: last Sunday March → October
    const m = now.getUTCMonth() + 1;
    const d = now.getUTCDate();
    const kyivUTCOffset = (m > 3 && m < 10) || (m === 3 && d >= 26) || (m === 10 && d < 29) ? 3 : 2;
    const targetUTC = MORNING_HOUR - kyivUTCOffset; // e.g. 10-3=7 or 10-2=8
    const next = new Date();
    next.setUTCHours(targetUTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  const ms = msUntilNext();
  console.log(`Morning report in ${Math.round(ms / 60000)} min (Kyiv 10:00)`);
  setTimeout(() => {
    sendMorningReport();
    // Re-schedule daily (recalculate each time for DST accuracy)
    setInterval(() => {
      sendMorningReport();
    }, 24 * 60 * 60 * 1000);
  }, ms);
}




// ═══════════════════════════════════════
// LAUNCH
// ═══════════════════════════════════════
// Clear any existing webhook and pending updates before launch
async function startBot() {
  // Wait for any previous instance to fully stop
  await new Promise(r => setTimeout(r, 3000));
  
  // Try to delete webhook and clear updates
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      console.log('Webhook cleared, attempt', attempt);
      break;
    } catch(e) {
      console.log(`Attempt ${attempt} failed:`, e.message);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  // Try to launch with retries
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log('EuroPost Bot started!');
      scheduleMorning();
      return;
    } catch(e) {
      console.log(`Launch attempt ${attempt} failed:`, e.message);
      if (attempt < 5) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  console.error('Failed to start bot after 5 attempts');
  process.exit(1);
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
