// checker.js — перебор чатов (click-through) — улучшено: один заголовок, без дублей дат/отправителей
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

function loadLastSeen() {
  if (fs.existsSync(LAST_SEEN_PATH)) {
    try { return JSON.parse(fs.readFileSync(LAST_SEEN_PATH, 'utf8')); }
    catch(e){ return { chats: {} }; }
  }
  return { chats: {} };
}
function saveLastSeen(obj) {
  fs.writeFileSync(LAST_SEEN_PATH, JSON.stringify(obj, null, 2));
}
function hashMessage(chatKey, text) {
  return crypto.createHash('sha256').update(`${chatKey}|${text}`).digest('hex');
}

// HTML-escape for Telegram HTML parse_mode
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegram(textHtml) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: textHtml, disable_web_page_preview: true, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) console.warn('Telegram API:', data);
  } catch (e) {
    console.error('Ошибка отправки в Telegram:', e);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatToHelsinki(raw) {
  if (!raw) return null;
  raw = String(raw).trim();
  // если в строке есть русские буквы (например "15 сентября 2025 г.") — возвращаем как есть
  if (/[а-яА-ЯЁё]/.test(raw)) return raw;
  try {
    const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (isoMatch) {
      const d = new Date(raw);
      if (!isNaN(d)) return formatDateInTZ(d);
    }
    if (/^\d+$/.test(raw)) {
      let ms = Number(raw);
      if (raw.length < 13) ms = ms * 1000;
      const d = new Date(ms);
      if (!isNaN(d)) return formatDateInTZ(d);
    }
    const hm = raw.match(/(^|\D)([0-2]?\d):([0-5]\d)($|\D)/);
    if (hm) {
      const hh = parseInt(hm[2], 10), mm = parseInt(hm[3], 10);
      const now = new Date();
      let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      if (candidate.getTime() > Date.now() + 5*60*1000) candidate = new Date(candidate.getTime() - 24*60*60*1000);
      return formatDateInTZ(candidate);
    }
    const parsed = Date.parse(raw);
    if (!isNaN(parsed)) return formatDateInTZ(new Date(parsed));
  } catch (e) {}
  return null;
}
function formatDateInTZ(dateObj, tz = 'Europe/Helsinki') {
  const opts = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('sv-SE', opts);
  const formatted = formatter.format(dateObj);
  return formatted.replace(',', '');
}

// build payloads: учитывает заголовок (chatHeaderHtml) при подсчёте длины
function buildPayloadsWithHeader(chatHeaderHtml, messageHtmlArray, maxLen = 3500) {
  const headerLen = chatHeaderHtml.length + 2; // +2 для перевода строк
  const chunks = [];
  let cur = [];
  let curLen = headerLen;
  for (const s of messageHtmlArray) {
    const sLen = s.length + 4; // добавляем запас для разделителя
    if (s.length > maxLen) {
      // если одиночное сообщение > maxLen, отправим то, что есть, потом это отдельно
      if (cur.length) { chunks.push(cur); cur = []; curLen = headerLen; }
      chunks.push([s]);
      continue;
    }
    if (curLen + sLen > maxLen) {
      chunks.push(cur);
      cur = [s];
      curLen = headerLen + s.length;
    } else {
      cur.push(s);
      curLen += sLen;
    }
  }
  if (cur.length) chunks.push(cur);
  // преобразуем: каждый chunk -> итоговый HTML = header + "\n\n" + join(chunk, separator)
  const separator = '\n\n────────\n\n';
  return chunks.map(chunk => chatHeaderHtml + '\n\n' + chunk.join(separator));
}

// helper: очистка/санитизация тела сообщения: удаляем ведущие повторы имени отправителя или даты/времени
function sanitizeMessageBody(rawText, sender, dateRaw, dateStr) {
  if (!rawText) return '';
  let t = String(rawText).trim();

  // remove leading date string if present (e.g. "15 сентября 2025 г.")
  if (dateRaw) {
    const dr = String(dateRaw).trim();
    if (dr && t.startsWith(dr)) {
      t = t.slice(dr.length).trim();
    }
  }
  // remove leading time like "20:19" on its own line or at start
  const timeMatch = t.match(/^([0-2]?\d:[0-5]\d)(\s*)/);
  if (timeMatch) {
    t = t.slice(timeMatch[0].length).trim();
  }
  // remove leading sender duplication patterns:
  if (sender) {
    const s = String(sender).trim();
    // possible patterns: 'Сферум\n', 'Сферум: ', '"Сферум": ', 'Сферум —', 'Сферум\nвладелец'
    const patterns = [
      new RegExp('^' + escapeRegExp(s) + '\\s*\\n', 'i'),
      new RegExp('^' + escapeRegExp(s) + '\\s*[:\\-—]\\s*', 'i'),
      new RegExp('^"' + escapeRegExp(s) + '"\\s*[:\\-—]\\s*', 'i'),
      new RegExp('^' + escapeRegExp(s) + '\\s*\\(.*?\\)\\s*', 'i')
    ];
    for (const p of patterns) {
      if (p.test(t)) {
        t = t.replace(p, '').trim();
      }
    }
    // additionally remove if first token equals sender and next token is role (like 'владелец')
    const firstLine = t.split('\n',1)[0].trim();
    if (firstLine === s || firstLine.startsWith(s + ' ')) {
      // if the first line equals sender, remove it
      if (t.indexOf('\n') !== -1) t = t.slice(t.indexOf('\n')+1).trim();
    }
  }

  return t;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- main ---
(async () => {
  const browser = await chromium.launch({ headless: true, args:['--no-sandbox','--disable-setuid-sandbox'] });
  const ctxOpts = {};
  if (fs.existsSync(STORAGE_PATH)) ctxOpts.storageState = STORAGE_PATH;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  console.log('Открываю', config.MAX_WEB);
  await page.goto(config.MAX_WEB, { waitUntil: 'networkidle', timeout: 60000 });

  const chatListSel = config.CHAT_LIST_SELECTOR;
  const chatItemSel = config.CHAT_ITEM_SELECTOR;
  const chatLinkSel = config.CHAT_LINK_SELECTOR || '';

  if (!chatListSel || !chatItemSel) {
    console.error('Укажите CHAT_LIST_SELECTOR и CHAT_ITEM_SELECTOR в config.json');
    await browser.close();
    process.exit(1);
  }

  try {
    await page.waitForSelector(chatListSel, { timeout: 8000 });
  } catch (e) {
    console.warn('Не найден контейнер списка чатов:', chatListSel);
  }

  await page.evaluate(async (params) => {
    const { scrollSel, rounds, pause } = params;
    const sc = document.querySelector(scrollSel);
    if (!sc) return;
    for (let i = 0; i < rounds; i++) {
      sc.scrollTop = sc.scrollHeight;
      await new Promise(r => setTimeout(r, pause));
    }
  }, { scrollSel: config.CHAT_LIST_SELECTOR, rounds: 6, pause: 300 });

  const items = await page.$$( `${chatListSel} ${chatItemSel}` );
  console.log('Найдено чатов в списке:', items.length);

  const lastSeen = loadLastSeen();
  const maxPerRun = Math.min(items.length, 80);

  for (let i = 0; i < maxPerRun; i++) {
    const itemHandle = items[i];
    try {
      const chatKey = await page.evaluate((el) => {
        const id = el.getAttribute('data-id') || el.getAttribute('data-peer') || el.getAttribute('data-chat-id') || null;
        const titleEl = el.querySelector('.title, .name, .peer, .chat-title') || el.querySelector('a') || el;
        const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : (id || 'chat_'+Math.random().toString(36).slice(2,8));
        return (id ? id : title);
      }, itemHandle);

      if (chatLinkSel) {
        const link = await itemHandle.$(chatLinkSel);
        if (link) await link.click(); else await itemHandle.click();
      } else {
        await itemHandle.scrollIntoViewIfNeeded();
        await itemHandle.click();
      }

      await page.waitForTimeout(config.CLICK_DELAY_MS || 800);

      try {
        await page.waitForSelector(config.MSG_LIST_SELECTOR, { timeout: 6000 });
      } catch (e) {
        console.warn('Сообщения не появились для chatKey=', chatKey);
        await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 300);
        continue;
      }

      await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        if (list) list.scrollTop = list.scrollHeight;
      }, config.MSG_LIST_SELECTOR);

      const messages = await page.evaluate((cfg) => {
        const {
          MSG_LIST_SELECTOR,
          MSG_ITEM_SELECTOR,
          CHAT_TITLE_SELECTOR,
          MSG_TEXT_SELECTOR,
          MSG_TIME_SELECTOR,
          MSG_DATE_SELECTOR,
          MSG_SENDER_SELECTOR,
          MAX_LAST_MESSAGES
        } = cfg;
        const list = document.querySelector(MSG_LIST_SELECTOR);
        if (!list) return [];
        const items = Array.from(list.querySelectorAll(MSG_ITEM_SELECTOR));
        const last = items.slice(-MAX_LAST_MESSAGES);
        const chatEl = document.querySelector(CHAT_TITLE_SELECTOR);
        const chatName = chatEl ? chatEl.innerText.trim() : '—';

        return last.map(el => {
          let text = '';
          if (MSG_TEXT_SELECTOR) {
            const tEl = el.querySelector(MSG_TEXT_SELECTOR);
            if (tEl) text = tEl.innerText.trim();
          }
          if (!text) text = el.innerText ? el.innerText.trim() : '';

          let sender = null;
          try {
            if (MSG_SENDER_SELECTOR) {
              const sEl = el.querySelector(MSG_SENDER_SELECTOR);
              if (sEl && sEl.innerText) sender = sEl.innerText.trim();
            }
            if (!sender) {
              const fallback = el.querySelector('.header .name .text') || el.querySelector('.author, .sender, .from, .name');
              if (fallback && fallback.innerText) sender = fallback.innerText.trim();
            }
          } catch (e) { sender = null; }

          let dateRaw = null;
          try {
            if (MSG_DATE_SELECTOR) {
              const dEl = el.querySelector(MSG_DATE_SELECTOR);
              if (dEl) dateRaw = (dEl.getAttribute('datetime') || dEl.getAttribute('title') || dEl.innerText || '').trim() || null;
            }
            if (!dateRaw && MSG_TIME_SELECTOR) {
              const tEl = el.querySelector(MSG_TIME_SELECTOR);
              if (tEl) dateRaw = (tEl.getAttribute('datetime') || tEl.getAttribute('title') || tEl.innerText || '').trim() || null;
            }
          } catch (e) {}

          if (!dateRaw) {
            try {
              let sib = el.previousElementSibling;
              let limit = 10;
              while (sib && limit-- > 0) {
                if (sib.classList && (sib.classList.contains('dateSeparator') || sib.className.includes('dateSeparator'))) {
                  const span = sib.querySelector('.date') || sib.querySelector('span');
                  if (span && span.innerText) { dateRaw = span.innerText.trim(); break; }
                }
                if (sib.querySelector) {
                  const innerDate = sib.querySelector && (sib.querySelector('.date') || sib.querySelector('span.date'));
                  if (innerDate && innerDate.innerText) { dateRaw = innerDate.innerText.trim(); break; }
                }
                sib = sib.previousElementSibling;
              }
            } catch (e) {}
          }

          const id = el.getAttribute('data-id') || el.getAttribute('data-index') || el.id || null;
          return { id, chat: chatName, text, dateRaw, sender };
        });
      }, {
        MSG_LIST_SELECTOR: config.MSG_LIST_SELECTOR,
        MSG_ITEM_SELECTOR: config.MSG_ITEM_SELECTOR,
        CHAT_TITLE_SELECTOR: config.CHAT_TITLE_SELECTOR,
        MSG_TEXT_SELECTOR: config.MSG_TEXT_SELECTOR,
        MSG_TIME_SELECTOR: config.MSG_TIME_SELECTOR,
        MSG_DATE_SELECTOR: config.MSG_DATE_SELECTOR,
        MSG_SENDER_SELECTOR: config.MSG_SENDER_SELECTOR,
        MAX_LAST_MESSAGES: config.MAX_LAST_MESSAGES || 30
      });

      if (!lastSeen.chats[chatKey]) lastSeen.chats[chatKey] = [];
      const seenSet = new Set(lastSeen.chats[chatKey]);

      // Build entries (chronological order)
      const entries = [];
      for (const msg of messages) {
        if (!msg.text || msg.text.length === 0) continue;
        const h = hashMessage(chatKey, msg.text);
        if (seenSet.has(h)) continue;

        // compute human-readable date (if exists)
        let dateStr = null;
        if (msg.dateRaw) {
          if (/[а-яА-ЯЁё]/.test(msg.dateRaw)) dateStr = msg.dateRaw;
          else dateStr = formatToHelsinki(msg.dateRaw) || null;
        }

        // sanitize body: remove repeated sender/date/time at top of message text
        const sanitizedBody = sanitizeMessageBody(msg.text, msg.sender, msg.dateRaw, dateStr);

        // build message HTML fragment WITHOUT chat header — header will be added once per payload
        // date will be handled when assembling payloads to avoid duplicates
        const senderHtml = msg.sender ? `&quot;${escapeHtml(msg.sender)}&quot;: ` : '';
        const bodyHtml = `${senderHtml}${escapeHtml(sanitizedBody)}`;

        entries.push({ dateStr, html: bodyHtml });
        seenSet.add(h);
      }

      // if no new entries, continue
      if (entries.length === 0) {
        // persist seen just in case
        lastSeen.chats[chatKey] = Array.from(seenSet).slice(-5000);
        saveLastSeen(lastSeen);
        await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 400);
        continue;
      }

      // Build messageHtmlArray where date is inserted only when differs from previous
      const messageHtmlArray = [];
      let prevDate = null;
      for (const e of entries) {
        // if date exists and different from prevDate -> include italic date line
        if (e.dateStr && e.dateStr !== prevDate) {
          messageHtmlArray.push(`<i>${escapeHtml(e.dateStr)}</i>`);
          prevDate = e.dateStr;
        }
        // always push message body (with sender in quotes)
        messageHtmlArray.push(e.html);
      }

      // prepare chat header (once)
      const chatHeaderHtml = `<b>${escapeHtml(entries[0] && entries[0].chatName ? entries[0].chatName : (entries[0] ? entries[0].chatName : '') )}</b>`;
      // but we don't have chatName in entries; get chat title separately
      const chatTitle = (entries.length && entries[0] && entries[0].chatName) ? entries[0].chatName : null;
      // better: get chat name from messages[0].chat (they all share same)
      const chatNameFromMsg = (messages && messages.length && messages[0].chat) ? messages[0].chat : chatKey;
      const headerHtml = `<b>${escapeHtml(chatNameFromMsg)}</b>`;

      // build payloads accounting for header length
      const payloads = buildPayloadsWithHeader(headerHtml, messageHtmlArray, config.BATCH_MAX_LENGTH || 3500);
      for (const payload of payloads) {
        await sendTelegram(payload);
        await sleep(300);
      }

      // persist seen
      lastSeen.chats[chatKey] = Array.from(seenSet).slice(-5000);
      saveLastSeen(lastSeen);

      await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 400);

    } catch (err) {
      console.warn('Ошибка при обработке чата index', i, err && err.message ? err.message : err);
    }
  }

  try {
    await context.storageState({ path: STORAGE_PATH });
    console.log('Обновлён storageState.json');
  } catch (e) { console.warn('Не удалось сохранить storageState:', e && e.message); }

  await browser.close();
  console.log('Done.');
  process.exit(0);
})();
