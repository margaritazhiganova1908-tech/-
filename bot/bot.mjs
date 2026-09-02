// HUMAN — телеграм-бот практики: маршрутизация запроса, мини-апп с разделами,
// заявки и вопросы куратору, деликатные догоняющие сообщения.
// Node 18+, без зависимостей. Запуск: BOT_TOKEN=... WEBAPP_URL=... node bot/bot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();
const CONTENT_PATH = process.env.CONTENT_PATH || path.join(DIR, 'content.json');
const STATE_PATH = process.env.STATE_PATH || path.join(DIR, 'data', 'state.json');
const API = `https://api.telegram.org/bot${TOKEN}`;
const HOUR = 3600 * 1000;

if (!TOKEN) { console.error('нет BOT_TOKEN — токен выдаёт @BotFather'); process.exit(1); }
if (!WEBAPP_URL.startsWith('https://')) {
  console.error('нет WEBAPP_URL или он не https — мини-апп открывается только по https');
  process.exit(1);
}

/* ---------- контент ---------- */
let content = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
fs.watchFile(CONTENT_PATH, { interval: 2000 }, () => {
  try { content = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8')); console.log('контент перечитан'); }
  catch (e) { console.error('контент сломан, оставил прежний:', e.message); }
});
const flow = () => content.flow;
const branch = (id) => flow().branches.find((b) => b.id === id);

/* ---------- состояние ---------- */
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { offset: 0, users: {}, leads: [], questions: 0, relay: {} };
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  }, 300);
}

/* ---------- api ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, payload) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.error_code === 429) { await sleep((data.parameters?.retry_after || 1) * 1000); continue; }
        if (data.error_code !== 403) console.error(method, data.description);
        return null;
      }
      return data.result;
    } catch (e) {
      if (attempt === 4) { console.error(method, e.message); return null; }
      await sleep(1000 * 2 ** attempt);
    }
  }
  return null;
}
const send = (chat, text, markup) =>
  api('sendMessage', { chat_id: chat, text, reply_markup: markup, disable_web_page_preview: true });

/* ---------- пользователи ---------- */
function who(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return `${name || 'без имени'}${u.username ? ' @' + u.username : ''} (id ${u.id})`;
}
function user(u) {
  const rec = state.users[u.id] || { id: u.id, first_seen: Date.now(), answers: {}, sent: [], sections: {} };
  rec.name = who(u);
  rec.last_seen = Date.now();
  state.users[u.id] = rec;
  return rec;
}
const notifyAdmin = (text, extra = {}) =>
  ADMIN_CHAT_ID ? api('sendMessage', { chat_id: ADMIN_CHAT_ID, text, ...extra }) : null;

/* ---------- клавиатуры ---------- */
function webAppButton(label, section) {
  const url = section ? `${WEBAPP_URL}${WEBAPP_URL.includes('?') ? '&' : '?'}section=${section}` : WEBAPP_URL;
  return { text: label, web_app: { url } };
}
function replyKeyboard() {
  const b = content.start.buttons;
  return {
    keyboard: [[webAppButton(b.webapp)], [{ text: b.ask }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function intentKeyboard() {
  return { inline_keyboard: flow().branches.map((b) => [{ text: b.label, callback_data: 'b:' + b.id }]) };
}
function stepKeyboard(branchId, stepIndex, options) {
  return { inline_keyboard: options.map((o) => [{ text: o.label, callback_data: `a:${branchId}:${stepIndex}:${o.id}` }]) };
}
function offerKeyboard(section) {
  const b = flow().buttons;
  const rows = [[{ text: b.book, callback_data: 'book' }]];
  rows.push([webAppButton(b.open, section)]);
  rows.push([{ text: b.ask, callback_data: 'ask' }]);
  rows.push([{ text: b.events, callback_data: 'consent:on' }]);
  return { inline_keyboard: rows };
}

/* ---------- сценарий ---------- */
async function onStart(msg) {
  const rec = user(msg.from);
  rec.branch = null; rec.answers = {}; rec.stage = 'intent';
  rec.started_at = Date.now(); rec.sent = []; rec.stopped = false;
  save();
  await send(msg.chat.id, flow().hello, replyKeyboard());
  await send(msg.chat.id, flow().askIntent, intentKeyboard());
}

async function askStep(chatId, rec, branchId, stepIndex) {
  const b = branch(branchId);
  const step = b.steps[stepIndex];
  rec.stage = `step:${branchId}:${stepIndex}`;
  save();
  await send(chatId, step.q, stepKeyboard(branchId, stepIndex, step.options));
}

async function showOffer(chatId, rec, branchId) {
  const b = branch(branchId);
  const lastAnswer = b.steps.length ? rec.answers[`${branchId}:${b.steps.length - 1}`] : 'default';
  const mirror = b.mirror[lastAnswer] || b.mirror.default || Object.values(b.mirror)[0];
  rec.stage = 'offer';
  save();
  if (mirror) { await send(chatId, mirror); await sleep(700); }
  await send(chatId, b.offer.text, offerKeyboard(b.offer.section));
}

async function onBranch(q, branchId) {
  const rec = user(q.from);
  rec.branch = branchId;
  rec.started_at = rec.started_at || Date.now();
  save();
  const b = branch(branchId);
  if (!b.steps.length) return showOffer(q.message.chat.id, rec, branchId);
  return askStep(q.message.chat.id, rec, branchId, 0);
}

async function onAnswer(q, branchId, stepIndex, optionId) {
  const rec = user(q.from);
  rec.answers[`${branchId}:${stepIndex}`] = optionId;
  save();
  const b = branch(branchId);
  const next = Number(stepIndex) + 1;
  if (next < b.steps.length) return askStep(q.message.chat.id, rec, branchId, next);
  return showOffer(q.message.chat.id, rec, branchId);
}

async function onBook(chatId, from, source) {
  const rec = user(from);
  rec.lead = true;
  state.leads.push({ user: who(from), id: from.id, branch: rec.branch || null, source, at: Date.now() });
  save();
  await send(chatId, content.cta.message, {
    inline_keyboard: [[{ text: content.cta.label, url: content.cta.url }]],
  });
  const path = Object.entries(rec.answers).map(([k, v]) => `${k}=${v}`).join(', ') || 'без анкеты';
  await notifyAdmin(`заявка от ${who(from)}\nветка: ${rec.branch || '—'}\nответы: ${path}\nисточник: ${source}`);
}

async function askQuestion(chatId, from) {
  const rec = user(from);
  rec.awaiting = true;
  save();
  await send(chatId, content.start.askPrompt);
}

async function onQuestion(msg) {
  const rec = user(msg.from);
  rec.awaiting = false;
  state.questions++;
  save();
  await send(msg.chat.id, content.start.askThanks);
  const sent = await notifyAdmin(`вопрос от ${who(msg.from)}\nветка: ${rec.branch || '—'}\n\n${msg.text}\n\nответьте реплаем на это сообщение.`);
  if (sent) { state.relay[sent.message_id] = msg.from.id; save(); }
}

/* ---------- кризисный маршрут ---------- */
function isCrisis(text) {
  const t = text.toLowerCase();
  return (flow().crisis.words || []).some((w) => t.includes(w));
}
async function onCrisis(msg) {
  const rec = user(msg.from);
  rec.crisis_at = Date.now();
  save();
  await send(msg.chat.id, flow().crisis.text);
  await notifyAdmin(`⚠️ тревожное сообщение от ${who(msg.from)}\n\n${msg.text}\n\nбот выдал контакты помощи и не продолжил диалог.`);
}

/* ---------- догоняющие сообщения ---------- */
async function runFollowups() {
  const now = Date.now();
  for (const rec of Object.values(state.users)) {
    if (rec.lead || rec.stopped || rec.crisis_at || !rec.started_at) continue;
    for (const f of flow().followups) {
      if ((rec.sent || []).includes(f.id)) continue;
      if (now - rec.started_at < f.afterHours * HOUR) continue;
      const ok = await sendFollowup(rec, f);
      rec.sent = rec.sent || [];
      rec.sent.push(f.id);
      save();
      if (!ok) break;
      await sleep(400);
      break; // не больше одного касания за проход
    }
  }
}
async function sendFollowup(rec, f) {
  const stop = [{ text: flow().buttons.stop, callback_data: 'stop' }];
  if (f.kind === 'objection') {
    const o = flow().objection;
    const rows = o.options.map((x) => [{ text: x.label, callback_data: 'obj:' + x.id }]);
    rows.push(stop);
    return send(rec.id, o.q, { inline_keyboard: rows });
  }
  if (f.kind === 'text') {
    const text = f.texts[rec.branch] || f.texts.explore;
    return send(rec.id, text, { inline_keyboard: [[{ text: flow().buttons.book, callback_data: 'book' }], stop] });
  }
  return send(rec.id, f.text, {
    inline_keyboard: [[{ text: content.cta.label, url: content.cta.url }], stop],
  });
}

/* ---------- админ ---------- */
async function onStats(msg) {
  const users = Object.values(state.users);
  const byBranch = {};
  for (const u of users) if (u.branch) byBranch[u.branch] = (byBranch[u.branch] || 0) + 1;
  const bySection = {};
  for (const u of users) for (const id of Object.keys(u.sections || {})) bySection[id] = (bySection[id] || 0) + 1;
  const reached = users.filter((u) => u.stage === 'offer' || u.lead).length;
  await send(msg.chat.id, [
    `пользователей: ${users.length}`,
    `дошли до предложения: ${reached}`,
    `заявок: ${state.leads.length}`,
    `вопросов: ${state.questions}`,
    `подписаны на события: ${users.filter((u) => u.consent).length}`,
    '',
    'ветки:',
    ...flow().branches.map((b) => `  ${b.label}: ${byBranch[b.id] || 0}`),
    '',
    'разделы мини-аппа:',
    ...content.sections.map((s) => `  ${s.title}: ${bySection[s.id] || 0}`),
  ].join('\n'));
}
async function onLeads(msg) {
  const last = state.leads.slice(-10).reverse();
  if (!last.length) return send(msg.chat.id, 'заявок пока нет');
  return send(msg.chat.id, last.map((l) => {
    const d = new Date(l.at).toLocaleString('ru-RU');
    return `${d} · ${l.user}\n  ветка: ${l.branch || '—'}, источник: ${l.source}`;
  }).join('\n\n'));
}
async function onBroadcast(msg, text) {
  const targets = Object.values(state.users).filter((u) => u.consent && !u.stopped);
  if (!text) return send(msg.chat.id, 'напишите: /say текст сообщения');
  state.draft = text;
  save();
  return send(msg.chat.id, `отправить ${targets.length} подписчикам?\n\n${text}`, {
    inline_keyboard: [[{ text: 'отправить', callback_data: 'say:go' }, { text: 'отмена', callback_data: 'say:no' }]],
  });
}
async function doBroadcast(chatId) {
  const text = state.draft;
  if (!text) return send(chatId, 'нечего отправлять');
  const targets = Object.values(state.users).filter((u) => u.consent && !u.stopped);
  let ok = 0;
  for (const t of targets) {
    if (await send(t.id, text, { inline_keyboard: [[{ text: flow().buttons.stop, callback_data: 'stop' }]] })) ok++;
    await sleep(120);
  }
  state.draft = null;
  save();
  return send(chatId, `отправлено: ${ok} из ${targets.length}`);
}

/* ---------- мини-апп ---------- */
async function onWebAppData(msg) {
  let data;
  try { data = JSON.parse(msg.web_app_data.data); } catch { return; }
  const rec = user(msg.from);
  if (data.action === 'progress') {
    rec.sections = rec.sections || {};
    rec.sections[data.section] = Math.max(rec.sections[data.section] || 0, data.slide || 0);
    save();
    return;
  }
  if (data.action === 'lead') return onBook(msg.chat.id, msg.from, 'мини-апп: ' + data.source);
}

/* ---------- маршрутизация ---------- */
async function onCallback(q) {
  const d = q.data || '';
  const chatId = q.message.chat.id;
  await api('answerCallbackQuery', { callback_query_id: q.id });

  if (d.startsWith('b:')) return onBranch(q, d.slice(2));
  if (d.startsWith('a:')) { const [, b, s, o] = d.split(':'); return onAnswer(q, b, s, o); }
  if (d === 'book') return onBook(chatId, q.from, 'кнопка в чате');
  if (d === 'ask') return askQuestion(chatId, q.from);
  if (d === 'consent:on') {
    const rec = user(q.from); rec.consent = true; save();
    return send(chatId, flow().consentOn);
  }
  if (d === 'stop') {
    const rec = user(q.from); rec.stopped = true; rec.consent = false; save();
    return send(chatId, flow().consentOff);
  }
  if (d.startsWith('obj:')) {
    const rec = user(q.from);
    const opt = flow().objection.options.find((o) => o.id === d.slice(4));
    rec.objection = d.slice(4); save();
    if (!opt) return null;
    return send(chatId, opt.reply, {
      inline_keyboard: [[{ text: flow().buttons.book, callback_data: 'book' }]],
    });
  }
  if (d === 'say:go' && String(chatId) === ADMIN_CHAT_ID) return doBroadcast(chatId);
  if (d === 'say:no' && String(chatId) === ADMIN_CHAT_ID) { state.draft = null; save(); return send(chatId, 'отменено'); }
  return null;
}

async function handle(update) {
  if (update.callback_query) return onCallback(update.callback_query);
  const msg = update.message;
  if (!msg || !msg.from) return;
  if (msg.web_app_data) return onWebAppData(msg);

  const isAdmin = ADMIN_CHAT_ID && String(msg.chat.id) === ADMIN_CHAT_ID;
  if (isAdmin && msg.reply_to_message && msg.text) {
    const userId = state.relay[msg.reply_to_message.message_id];
    if (userId) {
      await send(userId, msg.text);
      return send(msg.chat.id, 'ответ отправлен');
    }
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (isCrisis(text)) return onCrisis(msg);
  if (/^\/start\b/.test(text)) return onStart(msg);
  if (isAdmin && /^\/stats\b/.test(text)) return onStats(msg);
  if (isAdmin && /^\/leads\b/.test(text)) return onLeads(msg);
  if (isAdmin && /^\/say\b/.test(text)) return onBroadcast(msg, text.replace(/^\/say\s*/, ''));
  if (/^\/help\b/.test(text)) {
    return send(msg.chat.id, `/start — начать заново\n«${content.start.buttons.webapp}» — все разделы\n«${content.start.buttons.ask}» — написать мне лично`);
  }
  if (text === content.start.buttons.ask) return askQuestion(msg.chat.id, msg.from);
  return onQuestion(msg);
}

/* ---------- цикл ---------- */
async function main() {
  const me = await api('getMe', {});
  if (!me) { console.error('токен не принят'); process.exit(1); }
  console.log(`бот @${me.username} запущен, мини-апп: ${WEBAPP_URL}`);
  await api('setMyCommands', {
    commands: [{ command: 'start', description: 'начать' }, { command: 'help', description: 'что умеет бот' }],
  });
  setInterval(() => runFollowups().catch((e) => console.error('догонялки:', e.message)), 5 * 60 * 1000);

  for (;;) {
    const updates = await api('getUpdates', {
      offset: state.offset, timeout: 50, allowed_updates: ['message', 'callback_query'],
    });
    if (!updates) { await sleep(2000); continue; }
    for (const u of updates) {
      state.offset = u.update_id + 1;
      try { await handle(u); } catch (e) { console.error('обработка апдейта:', e.message); }
    }
    if (updates.length) save();
  }
}

main();
