// checker.js (updated — with time extraction & formatting)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { chromium } = require('playwright');

const config = require('./config.json');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;

if (!TG_TOKEN || !TG_CHAT) {
  console.error('Нужны переменные окружения TG_TOKEN и TG_CHAT');
  process.exit(1);
}

const STORAGE_PATH = path.resolve('storageState.json');
const LAST_SEEN_PATH = path.resolve('last_seen.json');

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('Telegram API returned not ok', data);
    }
  } catch (err) {
    console.error('Ошибка при отправке в Telegram:', err);
  }
}

function hashMessage(chat, text) {
  return crypto.createHash('sha256').update(`${chat}|${text}`).digest('hex');
}

function loadLastSeen() {
  if (fs.existsSync(LAST_SEEN_PATH)) {
    try { return JSON.parse(fs.readFileSync(LAST_SEEN_PATH, 'utf8')); }
    catch(e){ return { seen: [] }; }
  }
  return { seen: [] };
}

function saveLastSeen(obj) {
  fs.writeFileSync(LAST_SEEN_PATH, JSON.stringify(obj, null, 2));
}

/**
 * Попытка распарсить "сырое" значение времени из DOM/атрибутов.
 * Возвращает строку в формате "YYYY-MM-DD HH:mm" в часовом поясе Europe/Helsinki
 * или null если распознать не удалось.
 */
function formatToHelsinki(raw) {
  if (!raw) return null;
  raw = String(raw).trim();
  // common russian words
  const lower = raw.toLowerCase();

  try {
    // 1) Если ISO-подобная строка
    const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (isoMatch) {
      const d = new Date(raw);
      if (!isNaN(d)) return formatDateInTZ(d, 'Europe/Helsinki');
    }

    // 2) unix timestamp (число, секунды или миллисекунды)
    if (/^\d+$/.test(raw)) {
      const n = BigInt(raw);
      let ms = Number(n);
      // если длина >=13 — считаем миллисекундами
      if (raw.length >= 13) {
        // ms already
      } else {
        // секунды -> ms
        ms = ms * 1000;
      }
      const d = new Date(ms);
      if (!isNaN(d)) return formatDateInTZ(d, 'Europe/Helsinki');
    }

    // 3) время вида "HH:MM" (возможно с пробелами, AM/PM, или "10:23")
    const hm = raw.match(/(^|\D)([0-2]?\d):([0-5]\d)($|\D)/);
    if (hm) {
      const hh = parseInt(hm[2], 10);
      const mm = parseInt(hm[3], 10);
      // используем текущую дату в часовом поясе Europe/Helsinki
      const now = new Date();
      // Build a Date object with today's date (local), then format it into Helsinki timezone.
      // Это упрощение: предполагаем, что "HH:MM" относится к сегодняшней дате (или к вчерашней, если время в будущем — ниже поправка).
      let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      // Если полученное время кажется в будущем (например: сообщение вчера в 23:50, а сейчас 01:00), то скорректируем на -1 день
      const candidateInTZ = formatDateInTZ(candidate, 'Europe/Helsinki', true); // get comparable epoch
      const nowInTZ = formatDateInTZ(now, 'Europe/Helsinki', true);
      if (candidateInTZ > nowInTZ + 5*60*1000) {
        // слишком в будущем — вероятно сообщение вчера
        candidate = new Date(candidate.getTime() - 24*60*60*1000);
      }
      return formatDateInTZ(candidate, 'Europe/Helsinki');
    }

    // 4) относительные строки на русском: "сегодня", "вчера"
    if (lower.includes('сегодня')) {
      // пробуем извлечь время внутри строки
      const hm2 = raw.match(/([0-2]?\d):([0-5]\d)/);
      const now = new Date();
      let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (hm2) d.setHours(parseInt(hm2[1],10), parseInt(hm2[2],10), 0, 0);
      return formatDateInTZ(d, 'Europe/Helsinki');
    }
    if (lower.includes('вчера')) {
      const hm2 = raw.match(/([0-2]?\d):([0-5]\d)/);
      const now = new Date();
      let d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      if (hm2) d.setHours(parseInt(hm2[1],10), parseInt(hm2[2],10), 0, 0);
      return formatDateInTZ(d, 'Europe/Helsinki');
    }

    // 5) title/aria-label вроде "10:23, 15 Sep" — попытаемся Date.parse
    const parsed = Date.parse(raw);
    if (!isNaN(parsed)) {
      return formatDateInTZ(new Date(parsed), 'Europe/Helsinki');
    }
  } catch (e) {
    // fallthrough to null
  }

  return null;
}

/**
 * format date into "YYYY-MM-DD HH:mm" using Intl with given timezone.
 * If returnEpochOnly===true returns epoch ms for easy comparison.
 */
function formatDateInTZ(dateObj, tz = 'Europe/Helsinki', returnEpochOnly = false) {
  if (returnEpochOnly) return dateObj.getTime();
  // Using Intl to format in tz
  const opts = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  // Use 'sv' locale to get ISO-like date order "YYYY-MM-DD"
  const formatter = new Intl.DateTimeFormat('sv-SE', opts);
  // For some Node builds this returns "YYYY-MM-DD HH:mm"
  const formatted = formatter.format(dateObj); // typically "YYYY-MM-DD HH:mm"
  // Some environments may output like "YYYY-MM-DD HH:mm", but ensure space between date and time
  return formatted.replace(',', '');
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const contextOptions = {};
  if (fs.existsSync(STORAGE_PATH)) contextOptions.storageState = STORAGE_PATH;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  await page.goto(config.MAX_WEB, { waitUntil: 'networkidle', timeout: 60000 });

  // Подгрузим последние сообщения: прокрутим контейнер в низ (если контейнер виртуализирован — это поможет)
  await page.evaluate((sel) => {
    try {
      const list = document.querySelector(sel);
      if (list) {
        list.scrollTop = list.scrollHeight;
      }
    } catch (e) { /* ignore */ }
  }, config.MSG_LIST_SELECTOR);

  // извлекаем массив последних сообщений из DOM (и время, если есть)
  const messages = await page.evaluate((cfg) => {
    const { MSG_LIST_SELECTOR, MSG_ITEM_SELECTOR, CHAT_TITLE_SELECTOR, MSG_TEXT_SELECTOR, MSG_TIME_SELECTOR, MAX_LAST_MESSAGES } = cfg;
    const list = document.querySelector(MSG_LIST_SELECTOR);
    if (!list) return [];
    const items = Array.from(list.querySelectorAll(MSG_ITEM_SELECTOR));
    const last = items.slice(-MAX_LAST_MESSAGES);
    const chatEl = document.querySelector(CHAT_TITLE_SELECTOR);
    const chatName = chatEl ? chatEl.innerText.trim() : '—';

    return last.map(el => {
      // text
      let text = '';
      if (MSG_TEXT_SELECTOR) {
        const tEl = el.querySelector(MSG_TEXT_SELECTOR);
        if (tEl) text = tEl.innerText.trim();
      }
      if (!text) text = el.innerText ? el.innerText.trim() : '';

      // time raw: try explicit selector first
      let timeRaw = null;
      try {
        if (MSG_TIME_SELECTOR) {
          const t = el.querySelector(MSG_TIME_SELECTOR);
          if (t) {
            timeRaw = t.getAttribute('datetime') || t.getAttribute('title') || t.getAttribute('aria-label') || (t.innerText && t.innerText.trim()) || null;
          }
        }
      } catch(e) { /* ignore */ }

      // fallback: try attributes on message element itself
      if (!timeRaw) {
        timeRaw = el.getAttribute('data-time') || el.getAttribute('data-ts') || el.getAttribute('data-timestamp') || el.getAttribute('title') || el.getAttribute('aria-label') || null;
      }

      const id = el.getAttribute('data-id') || el.getAttribute('data-index') || el.id || null;
      return { id, chat: chatName, text, timeRaw };
    });
  }, config);

  const lastSeen = loadLastSeen();
  const seenSet = new Set(lastSeen.seen || []);

  // отправляем сообщения, которых не было в seen
  for (const msg of messages.reverse()) {
    if (!msg.text || msg.text.length === 0) continue;
    const h = hashMessage(msg.chat, msg.text);
    if (!seenSet.has(h)) {
      // попытка распарсить время
      let timeStr = formatToHelsinki(msg.timeRaw);
      // если не удалось распарсить — берем текущее время (в хелсинском)
      if (!timeStr) timeStr = formatDateInTZ(new Date(), 'Europe/Helsinki');

      const out = `📨 ${msg.chat}\n🕒 ${timeStr}\n\n${msg.text}`;
      console.log('NEW ->', out.slice(0,300));
      await sendTelegram(out);
      seenSet.add(h);
    }
  }

  // обновляем last_seen
  lastSeen.seen = Array.from(seenSet).slice(-5000); // лимит
  saveLastSeen(lastSeen);

  // обновляем storageState.json (Playwright)
  try {
    await context.storageState({ path: STORAGE_PATH });
    console.log('Обновлён storageState.json');
  } catch (e) {
    console.warn('Не удалось обновить storageState.json:', e.message || e);
  }

  await browser.close();
  process.exit(0);
})();
