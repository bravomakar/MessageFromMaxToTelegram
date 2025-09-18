// checker.js — полный файл с поддержкой пересылки фото в Telegram
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { chromium } = require('playwright');

const config = require('./config.json');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const ENCRYPT_KEY = process.env.ENCRYPT_KEY || process.env.ENCRYPT_KEY; // not used here but kept for context

if (!TG_TOKEN || !TG_CHAT) {
  console.error('Нужны переменные окружения TG_TOKEN и TG_CHAT');
  process.exit(1);
}

const STORAGE_PATH = path.resolve('storageState.json');
const LAST_SEEN_PATH = path.resolve('last_seen.json');
const ATTACH_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
const MAX_HASH_STORE = 5000;

// ---- helpers for last_seen ----
function loadLastSeen() {
  if (fs.existsSync(LAST_SEEN_PATH)) {
    try { return JSON.parse(fs.readFileSync(LAST_SEEN_PATH, 'utf8')); }
    catch (e) { return { chats: {} }; }
  }
  return { chats: {} };
}
function saveLastSeen(obj) {
  try {
    fs.writeFileSync(LAST_SEEN_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('Не удалось записать last_seen.json', e && e.message);
  }
}

// ---- hashing helpers ----
function hashSha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function hashMessageComposite(chatKey, id, text, imgIds = []) {
  if (id) return `${chatKey}|id:${id}`;
  // stable composite hash
  const payload = `${chatKey}|text:${text || ''}|imgs:${imgIds.join(',')}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ---- formatting helpers ----
function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- Telegram senders ----
async function sendTelegramTextHTML(html) {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 30000 });
    if (!(res.data && res.data.ok)) console.warn('Telegram sendMessage returned not ok', res.data);
    return res.data;
  } catch (e) {
    console.warn('sendTelegramTextHTML error', e && e.message);
    throw e;
  }
}

async function sendPhotoBuffer(buffer, filename, contentType, caption) {
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  if (caption) fd.append('caption', caption);
  fd.append('photo', buffer, { filename: filename || 'photo.jpg', contentType: contentType || 'image/jpeg' });
  const headers = fd.getHeaders();
  try {
    const res = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, fd, {
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000
    });
    if (!(res.data && res.data.ok)) console.warn('sendPhoto returned not ok', res.data);
    return res.data;
  } catch (e) {
    console.warn('sendPhotoBuffer error', e && e.message);
    throw e;
  }
}

async function sendMediaGroupBuffers(buffers /* [{buffer, name, contentType}] */, captionFirst) {
  // Telegram allows up to 10 media in one group
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  const media = [];
  for (let i = 0; i < buffers.length && i < 10; i++) {
    const key = `file${i}`;
    media.push({ type: 'photo', media: `attach://${key}`, caption: (i === 0 && captionFirst ? captionFirst : '') });
    fd.append(key, buffers[i].buffer, { filename: buffers[i].name || `img${i}.jpg`, contentType: buffers[i].contentType || 'image/jpeg' });
  }
  fd.append('media', JSON.stringify(media));
  try {
    const res = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMediaGroup`, fd, {
      headers: fd.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 90000
    });
    if (!(res.data && res.data.ok)) console.warn('sendMediaGroup returned not ok', res.data);
    return res.data;
  } catch (e) {
    console.warn('sendMediaGroupBuffers error', e && e.message);
    throw e;
  }
}

// ---- Playwright download probe & fetch (uses context.request) ----
async function probeAndDownload(ctxRequest, url) {
  try {
    // GET — Playwright will follow redirects and include cookies
    const resp = await ctxRequest.get(url, { timeout: 30000 });
    if (!resp.ok()) {
      return { ok: false, reason: 'http_error', status: resp.status(), url };
    }
    const headers = resp.headers();
    const ct = headers['content-type'] || 'application/octet-stream';
    const cl = headers['content-length'] ? Number(headers['content-length']) : null;
    // try to get filename from content-disposition
    let filename = null;
    if (headers['content-disposition']) {
      const m = headers['content-disposition'].match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
      if (m) filename = decodeURIComponent(m[1]);
    }
    if (!filename) {
      try {
        filename = path.basename((new URL(url)).pathname) || null;
      } catch (e) { filename = null; }
    }
    if (!filename) filename = `file_${Date.now()}`;

    if (cl && cl > ATTACH_SIZE_LIMIT) {
      return { ok: false, reason: 'too_large', size: cl, contentType: ct, filename, url };
    }
    // fetch body as buffer
    const buf = await resp.body();
    if (!buf) return { ok: false, reason: 'no_body', url };
    if (buf.length > ATTACH_SIZE_LIMIT) {
      return { ok: false, reason: 'too_large', size: buf.length, contentType: ct, filename, url };
    }
    return { ok: true, buffer: buf, size: buf.length, contentType: ct, filename, url };
  } catch (e) {
    return { ok: false, reason: 'exception', error: e.message, url };
  }
}

// ---- main script ----
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctxOpts = {};
  if (fs.existsSync(STORAGE_PATH)) ctxOpts.storageState = STORAGE_PATH;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  console.log('Открываю', config.MAX_WEB);
  try {
    await page.goto(config.MAX_WEB, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.error('Не удалось открыть MAX web:', e && e.message);
    await browser.close();
    process.exit(1);
  }

  // selectors from config
  const chatListSel = config.CHAT_LIST_SELECTOR;
  const chatItemSel = config.CHAT_ITEM_SELECTOR;
  const chatLinkSel = config.CHAT_LINK_SELECTOR || '';
  const msgListSel = config.MSG_LIST_SELECTOR;
  const msgItemSel = config.MSG_ITEM_SELECTOR;
  const chatTitleSel = config.CHAT_TITLE_SELECTOR;
  const msgTextSel = config.MSG_TEXT_SELECTOR || null;
  const msgTimeSel = config.MSG_TIME_SELECTOR || null;
  const MAX_LAST_MESSAGES = config.MAX_LAST_MESSAGES || 200;

  if (!chatListSel || !chatItemSel || !msgListSel || !msgItemSel || !chatTitleSel) {
    console.error('Ошибка: проверьте config.json - не все селекторы заданы.');
    await browser.close();
    process.exit(1);
  }

  // wait for chat list, scroll to load more
  try {
    await page.waitForSelector(chatListSel, { timeout: 8000 });
    await page.evaluate(async (params) => {
      const { sel, rounds, pause } = params;
      const el = document.querySelector(sel);
      if (!el) return;
      for (let i = 0; i < rounds; i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise(r => setTimeout(r, pause));
      }
    }, { sel: chatListSel, rounds: 6, pause: 300 });
  } catch (e) {
    console.warn('Не найден контейнер списка чатов:', e && e.message);
  }

  const items = await page.$$( `${chatListSel} ${chatItemSel}` );
  console.log('Найдено чатов в списке:', items.length);

  const lastSeen = loadLastSeen();
  const maxPerRun = Math.min(items.length, 80);

  for (let idx = 0; idx < maxPerRun; idx++) {
    const itemHandle = items[idx];
    try {
      // identify chatKey
      const chatKey = await page.evaluate((el) => {
        const id = el.getAttribute('data-id') || el.getAttribute('data-peer') || el.getAttribute('data-chat-id') || null;
        const titleEl = el.querySelector('.title, .name, .peer, .chat-title') || el.querySelector('a');
        const title = titleEl ? titleEl.innerText.trim() : (id || 'chat_' + Math.random().toString(36).slice(2,8));
        return id ? id : title;
      }, itemHandle);

      // click open chat
      if (chatLinkSel) {
        const link = await itemHandle.$(chatLinkSel);
        if (link) await link.click();
        else await itemHandle.click();
      } else {
        await itemHandle.scrollIntoViewIfNeeded();
        await itemHandle.click();
      }

      await page.waitForTimeout(config.CLICK_DELAY_MS || 800);

      // wait for messages container
      try {
        await page.waitForSelector(msgListSel, { timeout: 6000 });
      } catch (e) {
        console.warn('Сообщения не появились для chatKey=', chatKey);
        await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 300);
        continue;
      }

      // ensure scrolled to bottom to get newest messages
      await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        if (list) list.scrollTop = list.scrollHeight;
      }, msgListSel);

      // extract messages (id, text, time, sender, attachments)
      const rawMessages = await page.evaluate((cfg) => {
        const { msgListSel, msgItemSel, msgTextSel, msgTimeSel, chatTitleSel, maxLast } = cfg;
        const container = document.querySelector(msgListSel);
        if (!container) return [];
        const nodes = Array.from(container.querySelectorAll(msgItemSel));
        const lastNodes = maxLast ? nodes.slice(-maxLast) : nodes;
        const chatEl = document.querySelector(chatTitleSel);
        const chatName = chatEl ? chatEl.innerText.trim() : '—';

        function extractAttachments(el) {
          const res = [];
          // search common attachment patterns
          const blocks = el.querySelectorAll('.attaches, .media, .fileIcon, .grid, .tile, .attach, .attachment');
          for (const b of blocks) {
            try {
              // find <img>
              const img = b.querySelector('img');
              const url = img ? (img.src || img.getAttribute('data-src') || null) : null;
              // find textual info/size
              const info = b.innerText ? b.innerText.trim() : null;
              // get title
              const titleEl = b.querySelector('.title') || b.querySelector('.name');
              const title = titleEl ? titleEl.innerText.trim() : null;
              res.push({ url, info, title });
            } catch (e) {}
          }
          return res;
        }

        return lastNodes.map(n => {
          // check if this is date separator
          if (n.classList && (n.classList.contains('dateSeparator') || n.classList.contains('date'))) {
            const dt = n.innerText ? n.innerText.trim() : null;
            return { type: 'date', date: dt };
          }
          // otherwise message
          let text = '';
          if (msgTextSel) {
            const t = n.querySelector(msgTextSel);
            if (t) text = t.innerText.trim();
          }
          if (!text) {
            const tx = n.querySelector('.text');
            if (tx) text = tx.innerText.trim();
            else text = n.innerText ? n.innerText.trim() : '';
          }

          let timeRaw = null;
          if (msgTimeSel) {
            const t = n.querySelector(msgTimeSel);
            if (t) timeRaw = t.getAttribute('datetime') || t.getAttribute('title') || t.innerText || null;
          }
          if (!timeRaw) {
            timeRaw = n.getAttribute('data-time') || n.getAttribute('data-ts') || n.getAttribute('title') || null;
          }

          // try get sender
          let sender = null;
          try {
            const s = n.querySelector('.header .name .text') || n.querySelector('.header .name') || n.querySelector('.from, .sender');
            if (s) sender = s.innerText.trim();
          } catch (e) {}

          const id = n.getAttribute('data-id') || n.getAttribute('data-index') || n.id || null;
          const attaches = extractAttachments(n);
          return { type: 'msg', id, chat: chatName, text, timeRaw, sender, attaches };
        });
      }, { msgListSel, msgItemSel, msgTextSel, msgTimeSel, chatTitleSel, maxLast: MAX_LAST_MESSAGES });

      if (!lastSeen.chats[chatKey]) lastSeen.chats[chatKey] = [];
      const seenSet = new Set(lastSeen.chats[chatKey]);

      // We'll build an array of "send operations" to avoid interleaving multiple sends for a single chat
      const sendBlocks = [];

      for (const raw of rawMessages.slice().reverse()) {
        if (raw.type === 'date') {
          // skip date nodes; we will include date from msg.timeRaw if available
          continue;
        }
        if (raw.type !== 'msg') continue;

        const hasContent = (raw.text && raw.text.trim().length) || (raw.attaches && raw.attaches.length);
        if (!hasContent) continue;

        // compute unique id for message
        // if id present, use it (most robust)
        const uniqueBase = raw.id || null;
        // we'll compute image identifiers after potential download
        // but to decide whether to attempt download we can check url list and previously stored hashes
        // if uniqueBase present and in seenSet -> skip
        if (uniqueBase && seenSet.has(`${chatKey}|id:${uniqueBase}`)) continue;

        // prepare header parts
        const chatTitle = raw.chat || '—';
        const sender = raw.sender || null;
        const timeStr = raw.timeRaw ? (function parseTime(r){ try { const d = new Date(r); if (!isNaN(d)) return (new Intl.DateTimeFormat('sv-SE',{ timeZone:'Europe/Helsinki', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(d)).replace(',',''); } catch(e){} return r; })(raw.timeRaw) : null;

        // attachments processing
        const downloadable = [];
        const placeholders = []; // strings describing too large or inaccessible files
        if (raw.attaches && raw.attaches.length) {
          for (const att of raw.attaches) {
            const url = att.url;
            // if url is null or not http(s) -> placeholder
            if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
              placeholders.push('Прикреплённая фотография >50МБ или недоступна для просмотра, зайдите в Max');
              continue;
            }
            // probe & download using context.request
            const info = await probeAndDownload(context.request, url);
            if (!info.ok) {
              if (info.reason === 'too_large') placeholders.push('Прикреплённая фотография >50МБ или недоступна для просмотра, зайдите в Max');
              else placeholders.push('Прикреплённая фотография >50МБ или недоступна для просмотра, зайдите в Max');
            } else {
              // successful download (buffer <= limit)
              downloadable.push({ buffer: info.buffer, filename: info.filename, contentType: info.contentType, size: info.size, url: info.url });
            }
          }
        }

        // compute image-based identifiers for hash
        const imgIds = [];
        for (const dl of downloadable) {
          try {
            imgIds.push(hashSha256Buf(dl.buffer));
          } catch (e) {
            imgIds.push(dl.filename || dl.url || 'img');
          }
        }
        // for placeholders where we couldn't download, use filename/size or url
        // (this ensures that un-downloadable attachments still affect uniqueness)
        // We can include att.title or att.info but info may be inconsistent
        if (raw.attaches && raw.attaches.length) {
          for (const att of raw.attaches) {
            if (!att.url || !(att.url.startsWith('http://') || att.url.startsWith('https://'))) {
              imgIds.push(att.title || att.info || 'attachment');
            } else {
              // if we didn't download, add url/marker
              const found = downloadable.find(d => d.url === att.url);
              if (!found) imgIds.push(`remote:${att.url}`);
            }
          }
        }

        const compositeHash = hashMessageComposite(chatKey, raw.id || null, raw.text || '', imgIds);

        // dedupe
        if (seenSet.has(compositeHash)) continue;

        // prepare message blocks to send
        const parts = [];
        // chat title (once)
        parts.push(`<b>${escapeHtml(chatTitle)}</b>`);
        // date/time (italic if available)
        if (timeStr) parts.push(`<i>${escapeHtml(timeStr)}</i>`);
        // sender in quotes
        if (sender) parts.push(`&quot;${escapeHtml(sender)}&quot;`);
        // text body
        if (raw.text && raw.text.trim()) parts.push(escapeHtml(raw.text.trim()));

        // for downloadable images, we'll create send operations that include buffers
        // for placeholders -> simple text appended

        // Compose a sendBlock object that describes what to send for this message
        sendBlocks.push({
          chatKey,
          id: raw.id,
          compositeHash,
          parts, // array of html parts
          images: downloadable, // array of {buffer, filename, contentType}
          placeholders // array of placeholder strings
        });

        // mark as seen in set now (so if send blocks take long next run won't resend)
        seenSet.add(compositeHash);
      } // end messages loop

      // send accumulated blocks for this chat, oldest-first
      for (const block of sendBlocks) {
        try {
          // build caption/text
          const captionHtml = block.parts.join('\n\n');
          if ((!block.images || block.images.length === 0) && (!block.placeholders || block.placeholders.length === 0)) {
            // nothing to send? skip
            continue;
          }

          if (!block.images || block.images.length === 0) {
            // only placeholders/text -> single text message
            const finalText = `${captionHtml}\n\n${block.placeholders.join('\n')}`;
            await sendTelegramTextHTML(finalText);
          } else if (block.images.length === 1) {
            // single image — use sendPhoto with caption (caption limited to ~1024 chars)
            const img = block.images[0];
            const caption = captionHtml.length > 1000 ? captionHtml.slice(0, 1000) : captionHtml;
            try {
              await sendPhotoBuffer(img.buffer, img.filename, img.contentType, caption);
            } catch (e) {
              // fallback: send text + placeholder
              await sendTelegramTextHTML(`${caption}\n\nПрикреплённая фотография >50МБ или недоступна для просмотра, зайдите в Max`);
            }
            if (block.placeholders && block.placeholders.length) {
              await sendTelegramTextHTML(block.placeholders.join('\n'));
            }
          } else {
            // multiple images — send as media groups in chunks of 10
            const chunks = [];
            for (let i = 0; i < block.images.length; i += 10) {
              chunks.push(block.images.slice(i, i + 10));
            }
            for (let ci = 0; ci < chunks.length; ci++) {
              const pack = chunks[ci].map((p, ii) => ({ buffer: p.buffer, name: p.filename || `img_${ci}_${ii}.jpg`, contentType: p.contentType }));
              const caption = (ci === 0 ? (captionHtml.length > 1000 ? captionHtml.slice(0, 1000) : captionHtml) : '');
              try {
                await sendMediaGroupBuffers(pack, caption);
              } catch (e) {
                // fallback: send text + placeholders
                await sendTelegramTextHTML(`${caption}\n\nПрикреплённая фотография >50МБ или недоступна для просмотра, зайдите в Max`);
              }
              // small pause to avoid rate limits
              await page.waitForTimeout(400);
            }
            if (block.placeholders && block.placeholders.length) {
              await sendTelegramTextHTML(block.placeholders.join('\n'));
            }
          }
        } catch (e) {
          console.warn('Ошибка при отправке блока в Telegram:', e && e.message);
        }
        // short delay between messages
        await page.waitForTimeout(200);
      }

      // persist seen for this chat (cap length)
      lastSeen.chats[chatKey] = Array.from(seenSet).slice(-MAX_HASH_STORE);
      saveLastSeen(lastSeen);

      await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 400);

    } catch (err) {
      console.warn('Ошибка при обработке чата index', idx, (err && err.stack) ? err.stack : err);
    }
  } // end chats

  // save storageState
  try {
    await context.storageState({ path: STORAGE_PATH });
    console.log('Обновлён storageState.json');
  } catch (e) {
    console.warn('Не удалось сохранить storageState:', e && e.message);
  }

  await browser.close();
  console.log('Done.');
  process.exit(0);
})().catch(e => {
  console.error('Fatal error in checker.js:', e && e.stack ? e.stack : e);
  process.exit(1);
});
