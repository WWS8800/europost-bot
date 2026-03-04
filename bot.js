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
  issued:    { l: 'Видана адреса',        e: '📋' },
  ordered:   { l: 'Замовлено',            e: '📦' },
  warehouse: { l: 'На складі ЄС',         e: '🏭' },
  address:   { l: 'На адресі',            e: '🏠' },
  carrier:   { l: 'У перевізника',        e: '🚐' },
  np_sent:   { l: 'Відправлено НП',       e: '📮' },
  ua:        { l: 'В Україні',            e: '🇺🇦' },
  delivered: { l: 'Доставлено',           e: '✅' },
  cancelled: { l: 'Скасовано',            e: '❌' },
  legit:     { l: 'Легіт',               e: '👑' },
};

const STATUS_FLOW = ['issued','ordered','warehouse','address','carrier','np_sent','ua','delivered'];

function getNextStatus(current) {
  const idx = STATUS_FLOW.indexOf(current);
  if (idx >= 0 && idx < STATUS_FLOW.length - 1) return STATUS_FLOW[idx + 1];
  return null;
}

function fmtParcel(p, clients = [], carriers = []) {
  const cl = clients.find(c => c.id === p.client_id) || { name: '?' };
  const cr = carriers.find(c => c.id === p.carrier_id) || { name: '' };
  const st = STATUS[p.status] || { l: p.status, e: '📦' };
  const lines = [
    `*${p.id}*`,
    `${st.e} ${st.l}`,
    `👤 ${safe(cl.name)}`,
    `🏪 ${safe(p.shop)}${p.description ? ' — ' + safe(p.description) : ''}`,
    p.track ? `🔍 \`${p.track}\`` : null,
    `📅 ${p.date}${p.recv_date ? ' | Отримано: ' + p.recv_date : ''}`,
    `💰 Послуга: €${p.price} ${p.paid1 ? '✅' : '❌'}`,
    `🚐 Перевезення: €${p.ship_cost || 0} ${p.paid2 ? '✅' : '❌'}`,
    cr.name ? `🏢 ${safe(cr.name)}` : null,
    p.recv_data ? `📍 ${safe(p.recv_data)}` : null,
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

// DEBUG — log all messages
bot.use(async (ctx, next) => {
  if (ctx.message?.text) {
    console.log('MSG:', JSON.stringify(ctx.message.text), 'from:', ctx.from?.id);
  }
  if (ctx.callbackQuery?.data) {
    console.log('CB:', ctx.callbackQuery.data);
  }
  return next();
});

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
    const [parcels, clients, carriers] = await Promise.all([
      sbGet('parcels', `?id=eq.${id}`),
      sbGet('clients', '?select=id,name,tg'),
      sbGet('carriers', '?select=id,name'),
    ]);
    const p = parcels[0];
    if (!p) return ctx.reply(`Посилку ${id} не знайдено`);

    const text = fmtParcel(p, clients, carriers);
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
  sess(ctx).step = 'search';
  await ctx.reply('Введіть ID посилки (EU-XXXXXX) або tracking номер:');
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
    const clients = await sbGet('clients', '?status=eq.active&select=id,name,tg&order=name');
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

  // ── ISSUE ADDRESS TEXT STEPS ──
  if (s.step === 'ia_shop') {
    s.ia.shop = text;
    s.step = 'ia_method';
    // Find clean address automatically
    try {
      const { allAddrs, clean } = await iaFindCleanAddr(text);
      if (!clean.length) {
        s.step = null;
        return ctx.reply(
          `Для магазину "${text}" чистих адрес немає!\n` +
          `Всі ${allAddrs.length} адрес вже використовувались для цього магазину.`
        );
      }
      // Auto-pick first clean address
      const chosen = clean[0];
      s.ia.addr_id = chosen.id;
      s.ia.addrObj = chosen;

      const addrBlock = [
        chosen.name,
        chosen.street + ' ' + chosen.house + (chosen.door ? ', ' + chosen.door : ''),
        (chosen.zip || '') + ' ' + (chosen.city || ''),
        chosen.country || '',
        chosen.phone ? 'Tel: ' + chosen.phone : '',
      ].filter(Boolean).join('\n');

      await ctx.reply(
        `🏪 Магазин: ${text}\n` +
        `✅ Знайдено чисту адресу (${clean.length} з ${allAddrs.length} вільні):\n\n` +
        `📍 ${addrBlock}\n\n` +
        `Введіть метод (FTID / RTS / DAMAGE / DNA):`
      );
    } catch(e) {
      ctx.reply('Помилка пошуку адреси: ' + e.message);
    }
    return;
  }

  if (s.step === 'ia_method') {
    s.ia.method = text;
    s.step = 'ia_note';
    return ctx.reply(`Метод: ${text}\n\nПримітка (або /skip):`);
  }

  if (s.step === 'ia_note') {
    s.ia.note = text === '/skip' ? '' : text;
    s.step = null;
    await iaSave(ctx);
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
      const [clients, carriers] = await Promise.all([
        sbGet('clients', '?select=id,name,tg'),
        sbGet('carriers', '?select=id,name')
      ]);
      const p = parcels[0];
      await ctx.reply(fmtParcel(p, clients, carriers), { parse_mode: 'Markdown', ...parcelActions(p) });
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
// ISSUE ADDRESS — знайти чисту адресу
// ═══════════════════════════════════════
bot.hears(/Видати адресу/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  sess(ctx).step = null;
  sess(ctx).ia = {};

  try {
    const clients = await sbGet('clients', '?order=name&select=id,name,tg');
    if (!clients.length) return ctx.reply('Немає клієнтів в базі');

    const rows = clients.map(c =>
      [Markup.button.callback(c.name + (c.tg ? ' ' + c.tg : ''), `ia_cl_${c.id}`)]
    );
    rows.push([Markup.button.callback('« Скасувати', 'back_main')]);
    await ctx.reply('📍 Видача адреси\n\nКрок 1 — Оберіть клієнта:', Markup.inlineKeyboard(rows));
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

// Крок 1 — клієнт обраний → вводимо магазин текстом
bot.action(/^ia_cl_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = sess(ctx);
  const cId = parseInt(ctx.match[1]);
  try {
    const clients = await sbGet('clients', `?id=eq.${cId}&select=id,name,tg`);
    const cl = clients[0];
    s.ia = { client_id: cId, clientName: cl.name, clientTg: cl.tg || '' };
    s.step = 'ia_shop';
    await ctx.editMessageText(
      `👤 Клієнт: ${cl.name}\n\nКрок 2 — Введіть назву магазину:`
    );
  } catch (e) { ctx.reply('Помилка: ' + e.message); }
});

// Текстові кроки флоу
// ia_shop → ia_method → ia_note → збереження

async function iaFindCleanAddr(shop) {
  // Get all EU addresses
  const allAddrs = await sbGet('addresses', '?order=name&select=id,name,street,house,zip,city,country,phone,door');
  // Get all dirty records for this shop
  const dirty = await sbGet('dirty_addresses', `?shop=eq.${encodeURIComponent(shop)}&select=addr`);
  const usedAddrs = new Set(dirty.map(d => d.addr.trim().toLowerCase()));

  // Find clean addresses — not in dirty for this shop
  const clean = allAddrs.filter(a => {
    const key = (a.name + ' ' + a.street + ' ' + a.house).trim().toLowerCase();
    return !usedAddrs.has(key);
  });

  return { allAddrs, clean };
}

async function iaSave(ctx) {
  const s = sess(ctx);
  const ia = s.ia;
  const a = ia.addrObj;
  const today = new Date().toLocaleDateString('uk-UA');
  const todayISO = new Date().toISOString().split('T')[0];
  const addrKey = a.name + ' ' + a.street + ' ' + a.house;

  try {
    // 1. Грязні адреси
    await sbPost('dirty_addresses', {
      addr: addrKey,
      shop: ia.shop,
      tg: ia.clientTg,
      date: today,
      method: ia.method,
      note: ia.note || '',
    });

    // 2. Посилка
    const newId = 'EU-' + String(Date.now()).slice(-6);
    await sbPost('parcels', {
      id: newId,
      client_id: ia.client_id,
      addr_id: ia.addr_id,
      shop: ia.shop,
      date: todayISO,
      status: 'issued',
      price: 0,
      ship_cost: 0,
      paid1: false,
      paid2: false,
      note: ia.note || '',
    });

    // 3. Відповідь з повною адресою
    const addrBlock = [
      a.name,
      a.street + ' ' + a.house + (a.door ? ', ' + a.door : ''),
      (a.zip || '') + ' ' + (a.city || ''),
      a.country || '',
      a.phone ? 'Tel: ' + a.phone : '',
    ].filter(Boolean).join('\n');

    const msg = [
      '✅ Посилка ' + newId + ' створена',
      '',
      '👤 ' + ia.clientName + (ia.clientTg ? ' ' + ia.clientTg : ''),
      '🏪 ' + ia.shop,
      '📋 ' + ia.method,
      '📅 ' + today,
      ia.note ? '📝 ' + ia.note : '',
      '',
      '📍 АДРЕСА ДЛЯ ЗАМОВЛЕННЯ:',
      '─────────────────────',
      addrBlock,
      '─────────────────────',
    ].filter(l => l !== null).join('\n');

    s.ia = {};
    s.step = null;
    await ctx.reply(msg, mainMenu());
  } catch (e) {
    ctx.reply('Помилка збереження: ' + e.message);
  }
}

// ═══════════════════════════════════════
// MORNING REPORT
// ═══════════════════════════════════════
async function sendMorningReport() {
  if (!ADMIN_IDS.length) return;
  try {
    const parcels = await sbGet('parcels', '?select=status,price,ship_cost,paid1,paid2,client_id');
    const byStatus = {};
    parcels.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });

    const pending = parcels.filter(p => !p.paid1 && p.status !== 'cancelled').reduce((s, p) => s + (p.price || 0), 0);
    const debtMap = {};
    parcels.filter(p => p.status !== 'cancelled').forEach(p => {
      const owes = (p.paid1 ? 0 : (p.price || 0)) + (p.paid2 ? 0 : (p.ship_cost || 0));
      if (owes > 0) debtMap[p.client_id] = (debtMap[p.client_id] || 0) + owes;
    });

    const lines = [
      'Добрий ранок! Зведення EuroPost',
      new Date().toLocaleDateString('uk-UA'),
      '',
      `Всього посилок: ${parcels.length}`,
      `На складі ЄС: ${byStatus.warehouse || 0}`,
      `На адресі: ${byStatus.address || 0}`,
      `В дорозі: ${byStatus.carrier || 0}`,
      `В Україні: ${byStatus.ua || 0}`,
      '',
      `Очікується оплат: €${pending}`,
      `Боржників: ${Object.keys(debtMap).length}`,
    ];

    for (const adminId of ADMIN_IDS) {
      await bot.telegram.sendMessage(adminId, lines.join('\n'));
    }
  } catch (e) { console.error('Morning report error:', e.message); }
}

function scheduleMorning() {
  const now = new Date();
  const next = new Date();
  next.setHours(MORNING_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  console.log(`Morning report in ${Math.round(ms / 60000)} min`);
  setTimeout(() => {
    sendMorningReport();
    setInterval(sendMorningReport, 24 * 60 * 60 * 1000);
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
