/**
 * Пикник Афиши 2027 · сервер броней карты фудкортов.
 *
 * Работает внутри Google Таблицы (Расширения → Apps Script).
 * Хранит брони в листе «Брони», заявки на Сбер и гастрогид — в листе «Заявки».
 * Место считается занятым, пока в колонке «Статус» стоит «активна».
 * Снять бронь: поставить в «Статус» слово «снята» (или удалить строку),
 * либо нажать «Снять бронь» в режиме менеджера на карте (адрес карты + #admin).
 */

var MANAGER_EMAIL = 'margaritazhiganova1908@gmail.com'; // куда приходят уведомления
var SHEET_BOOKINGS = 'Брони';
var SHEET_REQUESTS = 'Заявки';
var ACTIVE = 'активна';
var CANCELLED = 'снята';

var HEAD = ['Номер брони', 'Точка (id)', 'Город', 'Зона', 'Место', 'Бренд', 'E-mail', 'Контакт',
            'Сумма, ₽', 'Площадь, м²', 'Скидка, %', 'Коэф. этапа', 'Комбо', 'Статус', 'Создана', 'Изменена'];
var REQ_HEAD = ['Тип', 'Имя / бренд', 'E-mail', 'Контакт', 'Создана'];

/** Запустите один раз из редактора: создаст листы, ключ менеджера и пришлёт его на почту. */
function setup() {
  sheet_(SHEET_BOOKINGS, HEAD);
  sheet_(SHEET_REQUESTS, REQ_HEAD);
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('ADMIN_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    props.setProperty('ADMIN_KEY', key);
  }
  MailApp.sendEmail(MANAGER_EMAIL, 'Ключ менеджера · карта фудкортов',
    'Ключ менеджера: ' + key + '\n\n' +
    'Откройте карту, добавьте в конец адреса #admin и введите этот ключ — появится список броней с поиском и кнопкой «Снять бронь».');
  Logger.log('Ключ менеджера: ' + key);
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'list';
  if (action === 'list') {
    var items = rows_().filter(isActive_).map(function (r) {
      // публично отдаём только то, что нужно карте: без e-mail и контактов
      return { id: r.id, booking: r.booking, brand: r.brand, area: r.area, disc: r.disc, k: r.k, combo: r.combo };
    });
    return json_({ ok: true, items: items });
  }
  return json_({ ok: false, error: 'unknown_action' });
}

function doPost(e) {
  var d;
  try { d = JSON.parse(e.postData.contents); } catch (x) { return json_({ ok: false, error: 'bad_request' }); }
  if (!d || typeof d !== 'object') return json_({ ok: false, error: 'bad_request' });
  if (d.action === 'book') return book_(d);
  if (d.action === 'request') return request_(d);
  if (d.action === 'adminList') {
    if (!isAdmin_(d.key)) return json_({ ok: false, error: 'forbidden' });
    return json_({ ok: true, items: rows_() });
  }
  if (d.action === 'cancel') return cancel_(d);
  return json_({ ok: false, error: 'unknown_action' });
}

// ---------- бронирование ----------
function book_(d) {
  var ids = Array.isArray(d.ids) ? d.ids.map(String) : [];
  var brand = clean_(d.brand, 60);
  var email = clean_(d.email, 120);
  var contact = clean_(d.contact, 120);
  if (!ids.length || ids.length > 6 || ids.some(function (id) { return !/^(msk|spb)(\|[A-Za-z0-9]{1,12}){2,3}$/.test(id); }))
    return json_({ ok: false, error: 'bad_place' });
  if (!brand) return json_({ ok: false, error: 'no_brand' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json_({ ok: false, error: 'bad_email' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
  try {
    var taken = {};
    rows_().filter(isActive_).forEach(function (r) { taken[r.id] = true; });
    var clash = ids.filter(function (id) { return taken[id]; });
    if (clash.length) return json_({ ok: false, error: 'taken', taken: clash });

    var number = 'PA-' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'MMdd') + '-' +
                 Utilities.getUuid().replace(/-/g, '').slice(0, 4).toUpperCase();
    var now = new Date();
    var sh = sheet_(SHEET_BOOKINGS, HEAD);
    ids.forEach(function (id) {
      sh.appendRow([number, id, clean_(d.city, 20), clean_(d.zone, 80), clean_(d.place, 160), brand, email, contact,
                    num_(d.sum), num_(d.area), num_(d.disc), num_(d.k), clean_(d.combo, 20), ACTIVE, now, now].map(safe_));
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var text = 'Забронировано место\n\n' +
    'Номер брони: ' + number + '\n' +
    'Город: ' + clean_(d.city, 20) + '\n' +
    'Место: ' + clean_(d.place, 160) + '\n' +
    'Бренд: ' + brand + '\n' +
    'E-mail: ' + email + '\n' +
    (contact ? 'Контакт: ' + contact + '\n' : '') +
    'Сумма: ' + rub_(d.sum) + '\n\n' +
    'Таблица броней: ' + SpreadsheetApp.getActive().getUrl();
  try { MailApp.sendEmail(MANAGER_EMAIL, 'Забронировано место', text, { replyTo: email, name: 'Карта фудкортов' }); } catch (x) { /* бронь уже сохранена */ }
  try {
    MailApp.sendEmail(email, 'Бронь принята · Пикник Афиши 2027',
      'Здравствуйте!\n\nВаша бронь принята.\n\n' +
      'Номер: ' + number + '\nМесто: ' + clean_(d.place, 160) + '\nБренд: ' + brand + '\nСумма: ' + rub_(d.sum) + '\n\n' +
      'Бронь предварительная. Менеджер свяжется с вами, чтобы оформить договор. ' +
      'Предоплата 20 000 ₽ — в течение 3 дней после выставления счёта.\n\nКоманда Пикника Афиши',
      { replyTo: MANAGER_EMAIL, name: 'Пикник Афиши' });
  } catch (x) { /* письмо резиденту не обязательно */ }

  return json_({ ok: true, booking: number });
}

// ---------- снятие брони менеджером ----------
function cancel_(d) {
  if (!isAdmin_(d.key)) return json_({ ok: false, error: 'forbidden' });
  var number = String(d.booking || '');
  if (!number) return json_({ ok: false, error: 'bad_request' });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
  var n = 0;
  try {
    var sh = sheet_(SHEET_BOOKINGS, HEAD);
    rows_().forEach(function (r) {
      if (r.booking === number && isActive_(r)) {
        sh.getRange(r.row, 14, 1, 3).setValues([[CANCELLED, r.at, new Date()]]);
        n++;
      }
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, cancelled: n });
}

// ---------- заявки (Сбер, гастрогид) ----------
function request_(d) {
  var type = d.type === 'sber' ? 'Спецоффер Сбер' : d.type === 'gastro' ? 'ГастроГид Афиши Рестораны' : '';
  var name = clean_(d.name, 80), email = clean_(d.email, 120), contact = clean_(d.contact, 120);
  if (!type || !name) return json_({ ok: false, error: 'bad_request' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json_({ ok: false, error: 'bad_email' });
  sheet_(SHEET_REQUESTS, REQ_HEAD).appendRow([type, name, email, contact, new Date()].map(safe_));
  try {
    MailApp.sendEmail(MANAGER_EMAIL, 'Заявка: ' + type,
      'Заявка: ' + type + '\nИмя / бренд: ' + name + '\nE-mail: ' + email + (contact ? '\nКонтакт: ' + contact : ''),
      { replyTo: email, name: 'Карта фудкортов' });
  } catch (x) { /* заявка сохранена в таблице */ }
  return json_({ ok: true });
}

// ---------- помощники ----------
function sheet_(name, head) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function rows_() {
  var sh = sheet_(SHEET_BOOKINGS, HEAD);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, booking: String(r[0]), id: String(r[1]), city: r[2], zone: r[3], place: r[4], brand: r[5],
             email: r[6], contact: r[7], sum: r[8], area: r[9], disc: r[10], k: r[11], combo: r[12],
             status: String(r[13]).trim().toLowerCase(), at: r[14], changed: r[15] };
  }).filter(function (r) { return r.id; });
}
function isActive_(r) { return r.status === ACTIVE; }
function isAdmin_(key) {
  var k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return !!k && String(key || '') === k;
}
function clean_(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function num_(v) { var n = Number(v); return isFinite(n) && v !== '' && v != null ? n : ''; }
function safe_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; } // без формул из формы
function rub_(v) { var n = Number(v) || 0; return n.toLocaleString('ru-RU') + ' ₽'; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
