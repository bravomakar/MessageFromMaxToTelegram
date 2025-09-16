// checker.js
// Watch VK Max web, send new messages to Telegram.
// Requirements: config.json in the same folder, Node 18+, playwright installed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

const MAX_MESSAGES_PER_CHAT = config.MAX_LAST_MESSAGES || 20;
const PER_CHAT_PAUSE_MS = config.PER_CHAT_PAUSE_MS || 400;
const CLICK_DELAY_MS = config.CLICK_DELAY_MS || 800;
const SAVE_CAP = config.SAVE_HASH_CAP || 5000;

// ----------------- Helpers -----------------
function loadLastSeen() {
  try {
    if (fs.existsSync(LAST_SEEN_PATH)) {
      return JSON.parse(fs.readFileSync(LAST_SEEN_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('Не удалось прочитать last_seen.json:', e && e.message);
  }
  return { chats: {} };
}

function saveLastSeen(obj) {
  try {
    const tmp = LAST_SEEN_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
    fs.renameSync(tmp, LAST_SEEN_PATH);
    console.log('Saved last_seen.json — chats:', Object.keys(obj.chats || {}).length);
  } catch (e) {
    console.error('Ошибка при сохранении last_seen.json:', e && e.message);
  }
}

function normalizeText(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/\r\n/g, '\n').replace(/\n+/g, '\n').replace(/[ \t]+/g, ' ').trim();
  // убрать ведущие timestamp-like
  t = t.replace(/^([0-2]?\d:[0-5]\d)\s*[-—–:]*\s*/,'');
  t = t.replace(/^(\d{1,2}\s+[А-Яа-яёЁ]+.*?г\.?)\s*/,'');
  return t;
}

function makeMessageKey(chatKey, msgId, text) {
  if (msgId) return `${chatKey}|id:${msgId}`;
  return `${chatKey}|txt:${normalizeText(text || '')}`;
}

function hashMessageKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// format date in Europe/Helsinki
function formatDateInTZ(dateObj, tz = 'Europe/Helsinki') {
  const opts = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('sv-SE', opts);
  const formatted = formatter.format(dateObj);
  return formatted.replace(',', '');
}

function formatToHelsinki(raw) {
  if (!raw) return null;
  raw = String(raw).trim();
  const lower = raw.toLowerCase();
  try {
    // ISO
    const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (isoMatch) {
      const d = new Date(raw);
      if (!isNaN(d)) return formatDateInTZ(d, 'Europe/Helsinki');
    }
    // unix seconds / ms
    if (/^\d+$/.test(raw)) {
      let ms = Number(raw);
      if (raw.length < 13) ms = ms * 1000;
      const d = new Date(ms);
      if (!isNaN(d)) return formatDateInTZ(d, 'Europe/Helsinki');
    }
    // hh:mm
    const hm = raw.match(/(^|\D)([0-2]?\d):([0-5]\d)($|\D)/);
    if (hm) {
      const hh = parseInt(hm[2], 10), mm = parseInt(hm[3], 10);
      const now = new Date();
      let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      const candEpoch = candidate.getTime();
      const nowEpoch = now.getTime();
      if (candEpoch > nowEpoch + 5*60*1000) candidate = new Date(candidate.getTime() - 24*60*60*1000);
      return formatDateInTZ(candidate, 'Europe/Helsinki');
    }
    if (lower.includes('сегодня')) {
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
    const parsed = Date.parse(raw);
    if (!isNaN(parsed)) return formatDateInTZ(new Date(parsed), 'Europe/Helsinki');
  } catch (e) {}
  return null;
}

// send to Telegram using HTML parse mode
async function sendTelegramHtml(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('Telegram API warning:', data);
      throw new Error('Telegram API returned not ok');
    }
    return data;
  } catch (e) {
    console.error('Ошибка отправки в Telegram:', e && e.message);
    throw e;
  }
}

// ----------------- Main -----------------
(async () => {
  const lastSeen = loadLastSeen();

  const browser = await chromium.launch({ headless: true, args:['--no-sandbox','--disable-setuid-sandbox'] });
  const ctxOpts = {};
  if (fs.existsSync(STORAGE_PATH)) ctxOpts.storageState = STORAGE_PATH;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  console.log('Открываю', config.MAX_WEB);
  await page.goto(config.MAX_WEB, { waitUntil: 'networkidle', timeout: 60000 });

  // selectors from config
  const chatListSel = config.CHAT_LIST_SELECTOR;
  const chatItemSel = config.CHAT_ITEM_SELECTOR;
  const chatLinkSel = config.CHAT_LINK_SELECTOR || null;
  const msgListSel = config.MSG_LIST_SELECTOR;
  const msgItemSel = config.MSG_ITEM_SELECTOR;
  const msgTextSel = config.MSG_TEXT_SELECTOR || null;
  const msgTimeSel = config.MSG_TIME_SELECTOR || null;
  const chatTitleSel = config.CHAT_TITLE_SELECTOR || null;
  const msgSenderSel = config.MSG_SENDER_SELECTOR || null;

  if (!chatListSel || !chatItemSel || !msgListSel || !msgItemSel) {
    console.error('Укажите CHAT_LIST_SELECTOR, CHAT_ITEM_SELECTOR, MSG_LIST_SELECTOR и MSG_ITEM_SELECTOR в config.json');
    await browser.close();
    process.exit(1);
  }

  try {
    await page.waitForSelector(chatListSel, { timeout: 8000 });
  } catch (e) {
    console.warn('Не найден контейнер списка чатов:', chatListSel);
  }

  // scroll chat list to load more
  await page.evaluate(async (params) => {
    const { scrollSel, rounds, pause } = params;
    const sc = document.querySelector(scrollSel);
    if (!sc) return;
    for (let i = 0; i < rounds; i++) {
      sc.scrollTop = sc.scrollHeight;
      await new Promise(r => setTimeout(r, pause));
    }
  }, { scrollSel: chatListSel, rounds: 6, pause: 300 });

  // get chat items
  const items = await page.$$( `${chatListSel} ${chatItemSel}` );
  console.log('Найдено чатов в списке:', items.length);

  const cap = Math.min(items.length, 80);

  for (let i = 0; i < cap; i++) {
    const itemHandle = items[i];
    try {
      // get chatKey (use attributes if possible)
      const chatKey = await itemHandle.evaluate((el) => {
        const id = el.getAttribute('data-id') || el.getAttribute('data-peer') || el.getAttribute('data-chat-id') || null;
        let title = null;
        const titleEl = el.querySelector('.title, .name, .peer, .chat-title') || el.querySelector('a') || el.querySelector('span');
        if (titleEl) title = titleEl.innerText.trim();
        return (id ? id : (title || ('chat_' + Math.random().toString(36).slice(2,8))));
      });

      // click the chat item (or its link) to open
      if (chatLinkSel) {
        const link = await itemHandle.$(chatLinkSel);
        if (link) {
          await link.click();
        } else {
          await itemHandle.scrollIntoViewIfNeeded();
          await itemHandle.click();
        }
      } else {
        await itemHandle.scrollIntoViewIfNeeded();
        await itemHandle.click();
      }

      await page.waitForTimeout(CLICK_DELAY_MS);

      // wait for messages container
      try {
        await page.waitForSelector(msgListSel, { timeout: 6000 });
      } catch (e) {
        console.warn('Сообщения не появились для chatKey=', chatKey);
        await page.waitForTimeout(PER_CHAT_PAUSE_MS);
        continue;
      }

      // scroll messages to bottom
      await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        if (list) list.scrollTop = list.scrollHeight;
      }, msgListSel);

      // extract messages (returns array oldest->newest)
      const messages = await page.evaluate((cfg) => {
        const { MSG_LIST_SELECTOR, MSG_ITEM_SELECTOR, CHAT_TITLE_SELECTOR, MSG_TEXT_SELECTOR, MSG_TIME_SELECTOR, MSG_SENDER_SELECTOR, MAX_LAST_MESSAGES } = cfg;
        const list = document.querySelector(MSG_LIST_SELECTOR);
        if (!list) return [];
        const items = Array.from(list.querySelectorAll(MSG_ITEM_SELECTOR));
        // take last MAX_LAST_MESSAGES, but keep original order (oldest -> newest)
        const last = items.slice(-MAX_LAST_MESSAGES);
        const chatEl = CHAT_TITLE_SELECTOR ? document.querySelector(CHAT_TITLE_SELECTOR) : null;
        const chatName = chatEl ? chatEl.innerText.trim() : '—';
        return last.map(el => {
          let text = '';
          try {
            if (MSG_TEXT_SELECTOR) {
              const tEl = el.querySelector(MSG_TEXT_SELECTOR);
              if (tEl) text = tEl.innerText.trim();
            }
            if (!text) text = el.innerText ? el.innerText.trim() : '';
          } catch(e) { text = el.innerText ? el.innerText.trim() : ''; }

          let timeRaw = null;
          try {
            if (MSG_TIME_SELECTOR) {
              const t = el.querySelector(MSG_TIME_SELECTOR);
              if (t) timeRaw = t.getAttribute('datetime') || t.getAttribute('title') || t.getAttribute('aria-label') || (t.innerText && t.innerText.trim()) || null;
            }
          } catch(e) {}
          if (!timeRaw) {
            timeRaw = el.getAttribute('data-time') || el.getAttribute('data-ts') || el.getAttribute('title') || el.getAttribute('aria-label') || null;
          }

          // attempt to find sender
          let sender = null;
          try {
            if (MSG_SENDER_SELECTOR) {
              const s = el.querySelector(MSG_SENDER_SELECTOR);
              if (s) sender = s.innerText.trim();
            }
            if (!sender) {
              const hdr = el.querySelector('.header, .from, .author, .meta');
              if (hdr) {
                const n = hdr.querySelector('.name, .text, .author-name, span');
                if (n) sender = n.innerText.trim();
                else sender = hdr.innerText.trim();
              }
            }
          } catch(e) { sender = null; }

          const id = el.getAttribute('data-id') || el.getAttribute('data-index') || el.id || null;
          return { id, chat: chatName, text, timeRaw, sender };
        });
      }, {
        MSG_LIST_SELECTOR: msgListSel,
        MSG_ITEM_SELECTOR: msgItemSel,
        CHAT_TITLE_SELECTOR: chatTitleSel,
        MSG_TEXT_SELECTOR: msgTextSel,
        MSG_TIME_SELECTOR: msgTimeSel,
        MSG_SENDER_SELECTOR: msgSenderSel,
        MAX_LAST_MESSAGES: MAX_MESSAGES_PER_CHAT
      });

      // ensure bucket
      if (!lastSeen.chats[chatKey]) lastSeen.chats[chatKey] = [];
      const seenSet = new Set(lastSeen.chats[chatKey]);

      // messages are oldest -> newest
      let found = 0, sent = 0;
      const toSend = [];

      for (const msg of messages) {
        found++;
        if (!msg.text || msg.text.trim().length === 0) continue;
        const msgId = msg.id || null;
        const key = makeMessageKey(chatKey, msgId, msg.text);
        const h = hashMessageKey(key);
        if (!seenSet.has(h)) {
          // prepare HTML payload (chat bold, date italic, sender in quotes)
          let timeStr = null;
          if (msg.timeRaw) timeStr = formatToHelsinki(msg.timeRaw);
          const chatHtml = `<b>${escapeHtml(msg.chat || '—')}</b>`;
          const dateHtml = timeStr ? ` <i>${escapeHtml(timeStr)}</i>` : '';
          const senderHtml = msg.sender ? `&quot;${escapeHtml(msg.sender)}&quot;: ` : '';
          // body: sender (in quotes) then message text
          const bodyHtml = `${senderHtml}${escapeHtml(msg.text)}`;
          const finalHtml = `${chatHtml}${dateHtml}\n\n${bodyHtml}`;
          toSend.push({ hash: h, payload: finalHtml });
        }
      }

      // send in order (oldest -> newest)
      for (const item of toSend) {
        try {
          await sendTelegramHtml(item.payload);
          // mark as seen only after successful send
          seenSet.add(item.hash);
          sent++;
          await page.waitForTimeout(150);
        } catch (e) {
          console.warn('Telegram send failed, not adding to seenSet for this message.');
        }
      }

      // persist seen for this chat (cap length)
      lastSeen.chats[chatKey] = Array.from(seenSet).slice(-SAVE_CAP);
      saveLastSeen(lastSeen);

      console.log(`chatKey=${chatKey} — found=${found}, new_to_send=${sent}`);

      // slight pause between chats
      await page.waitForTimeout(PER_CHAT_PAUSE_MS);

    } catch (err) {
      console.warn('Ошибка при обработке чата index', i, err && (err.message || err));
    }
  }

  // save updated storageState
  try {
    await context.storageState({ path: STORAGE_PATH });
    console.log('Обновлён storageState.json');
  } catch (e) {
    console.warn('Не удалось сохранить storageState:', e && e.message);
  }

  await browser.close();
  console.log('Done.');
  process.exit(0);
})();
