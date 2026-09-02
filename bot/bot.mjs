// Телеграм-бот «колода»: приветствие → мини-апп с 7 слайдами → заявки и вопросы в чат куратора.
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

if (!TOKEN) { console.error('нет BOT_TOKEN — токен выдаёт @BotFather'); process.exit(1); }
if (!WEBAPP_URL.startsWith('https://')) {
  console.error('нет WEBAPP_URL или он не https — мини-апп открывается только по https');
  process.exit(1);
}

/* ---------- контент ---------- */
let content = load();
function load() {
  return JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
}
fs.watchFile(CONTENT_PATH, { interval: 2000 }, () => {
  try { content = load(); console.log('контент перечитан'); }
  catch (e) { console.error('контент сломан, оставил прежний:', e.message); }
});

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
        if (data.error_code === 429) {
          await sleep((data.parameters?.retry_after || 1) * 1000);
          continue;
        }
        console.error(method, data.description);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- клавиатуры ---------- */
function keyboards() {
  const b = content.start.buttons;
  return {
    // обычная клавиатура: только из неё мини-апп умеет отправлять данные обратно в бота
    reply: {
      keyboard: [[{ text: b.webapp, web_app: { url: WEBAPP_URL } }], [{ text: b.ask }]],
      resize_keyboard: true,
      is_persistent: true,
    },
    inline: {
      inline_keyboard: [
        [{ text: b.webapp, web_app: { url: WEBAPP_URL } }],
        [{ text: b.ask, callback_data: 'ask' }],
      ],
    },
  };
}

/* ---------- сценарии ---------- */
function who(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return `${name || 'без имени'}${u.username ? ' @' + u.username : ''} (id ${u.id})`;
}

function touch(u) {
  const rec = state.users[u.id] || { id: u.id, first_seen: Date.now(), slides: 0 };
  rec.name = who(u);
  rec.last_seen = Date.now();
  state.users[u.id] = rec;
  save();
  return rec;
}

async function notifyAdmin(text, extra = {}) {
  if (!ADMIN_CHAT_ID) return null;
  return api('sendMessage', { chat_id: ADMIN_CHAT_ID, text, ...extra });
}

async function onStart(msg) {
  touch(msg.from);
  const kb = keyboards();
  await api('sendMessage', { chat_id: msg.chat.id, text: content.start.text, reply_markup: kb.reply });
  await api('sendMessage', {
    chat_id: msg.chat.id,
    text: content.brand.name.toLowerCase(),
    reply_markup: kb.inline,
  });
}

async function askQuestion(chatId, userId) {
  state.users[userId] = { ...(state.users[userId] || { id: userId }), awaiting: true };
  save();
  await api('sendMessage', { chat_id: chatId, text: content.start.askPrompt });
}

async function onQuestion(msg) {
  const rec = state.users[msg.from.id] || {};
  rec.awaiting = false;
  state.users[msg.from.id] = rec;
  state.questions++;
  save();
  await api('sendMessage', { chat_id: msg.chat.id, text: content.start.askThanks });
  const sent = await notifyAdmin(`вопрос от ${who(msg.from)}:\n\n${msg.text}\n\nответь реплаем на это сообщение.`);
  if (sent) { state.relay[sent.message_id] = msg.from.id; save(); }
}

async function onAdminReply(msg) {
  const userId = state.relay[msg.reply_to_message.message_id];
  if (!userId) return false;
  await api('sendMessage', { chat_id: userId, text: msg.text });
  await api('sendMessage', { chat_id: msg.chat.id, text: 'ответ отправлен' });
  return true;
}

async function onWebAppData(msg) {
  let data;
  try { data = JSON.parse(msg.web_app_data.data); } catch { return; }
  const rec = touch(msg.from);

  if (data.action === 'progress') {
    rec.sections = rec.sections || {};
    rec.sections[data.section] = Math.max(rec.sections[data.section] || 0, data.slide || 0);
    save();
    return;
  }
  if (data.action === 'lead') {
    state.leads.push({ user: who(msg.from), id: msg.from.id, source: data.source, seen: data.seen, at: Date.now() });
    save();
    await api('sendMessage', {
      chat_id: msg.chat.id,
      text: content.cta.message,
      reply_markup: content.cta.url
        ? { inline_keyboard: [[{ text: content.cta.label, url: content.cta.url }]] }
        : undefined,
    });
    var opened = Object.keys(rec.sections || {}).join(', ') || 'нет';
    await notifyAdmin(`заявка от ${who(msg.from)}\nоткуда: ${data.source}\nсмотрел(а) разделы: ${opened}`);
  }
}

async function onStats(msg) {
  const users = Object.values(state.users);
  // сколько раз открывали каждый раздел
  const bySection = {};
  for (const u of users) {
    for (const id of Object.keys(u.sections || {})) bySection[id] = (bySection[id] || 0) + 1;
  }
  const top = content.sections
    .map((s) => `  ${s.title}: ${bySection[s.id] || 0}`)
    .join('\n');
  await api('sendMessage', {
    chat_id: msg.chat.id,
    text: [
      `пользователей: ${users.length}`,
      `заявок: ${state.leads.length}`,
      `вопросов: ${state.questions}`,
      '',
      'открывали разделы:',
      top,
    ].join('\n'),
  });
}

/* ---------- маршрутизация ---------- */
async function handle(update) {
  if (update.callback_query) {
    const q = update.callback_query;
    await api('answerCallbackQuery', { callback_query_id: q.id });
    if (q.data === 'ask') await askQuestion(q.message.chat.id, q.from.id);
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;

  if (msg.web_app_data) return onWebAppData(msg);

  const isAdmin = ADMIN_CHAT_ID && String(msg.chat.id) === ADMIN_CHAT_ID;
  if (isAdmin && msg.reply_to_message && msg.text) {
    if (await onAdminReply(msg)) return;
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (/^\/start\b/.test(text)) return onStart(msg);
  if (/^\/stats\b/.test(text) && isAdmin) return onStats(msg);
  if (/^\/help\b/.test(text)) {
    return api('sendMessage', {
      chat_id: msg.chat.id,
      text: '/start — начать заново\nкнопка «' + content.start.buttons.webapp + '» — колода со всеми деталями\nкнопка «' + content.start.buttons.ask + '» — написать куратору',
    });
  }
  if (text === content.start.buttons.ask) return askQuestion(msg.chat.id, msg.from.id);
  if (state.users[msg.from.id]?.awaiting) return onQuestion(msg);

  // любое свободное сообщение считаем вопросом — так короче путь до куратора
  return onQuestion(msg);
}

/* ---------- цикл ---------- */
async function main() {
  const me = await api('getMe', {});
  if (!me) { console.error('токен не принят'); process.exit(1); }
  console.log(`бот @${me.username} запущен, мини-апп: ${WEBAPP_URL}`);
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'начать' },
      { command: 'help', description: 'что умеет бот' },
    ],
  });

  for (;;) {
    const updates = await api('getUpdates', {
      offset: state.offset,
      timeout: 50,
      allowed_updates: ['message', 'callback_query'],
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
