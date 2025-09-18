// checker.js — полный файл с подсчётом новых сообщений/фот и обработкой больших файлов
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
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
const ATTACH_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
const MAX_HASH_STORE = 5000;

// ---- last_seen helpers ----
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

// ---- hashing ----
function hashSha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function hashMessageComposite(chatKey, id, text, imgIds = []) {
  if (id) return `${chatKey}|id:${id}`;
  const payload = `${chatKey}|text:${text || ''}|imgs:${imgIds.join(',')}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ---- formatting ----
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
  try {
    const res = await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, fd, {
      headers: fd.getHeaders(),
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

async function sendMediaGroupBuffers(buffers /* [{buffer,name,contentType}] */, captionFirst) {
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

// ---- Playwright download (uses context.request) ----
async function probeAndDownload(ctxRequest, url) {
  try {
    const resp = await ctxRequest.get(url, { timeout: 30000 });
    if (!resp.ok()) {
      return { ok: false, reason: 'http_error', status: resp.status(), url };
    }
    const headers = resp.headers();
    const ct = headers['content-type'] || 'application/octet-stream';
    const cl = headers['content-length'] ? Number(headers['content-length']) : null;
    let filename = null;
    if (headers['content-disposition']) {
      const m = headers['content-disposition'].match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
      if (m) filename = decodeURIComponent(m[1]);
    }
    if (!filename) {
      try { filename = path.basename((new URL(url)).pathname) || null; } catch (e) { filename = null; }
    }
    if (!filename) filename = `file_${Date.now()}`;

    if (cl && cl > ATTACH_SIZE_LIMIT) {
      return { ok: false, reason: 'too_large', size: cl, contentType: ct, filename, url };
    }

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

// ---- main ----
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

  // selectors
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

  // wait & scroll
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
      const chatKey = await page.evaluate((el) => {
        const id = el.getAttribute('data-id') || el.getAttribute('data-peer') || el.getAttribute('data-chat-id') || null;
        const titleEl = el.querySelector('.title, .name, .peer, .chat-title') || el.querySelector('a');
        const title = titleEl ? titleEl.innerText.trim() : (id || 'chat_' + Math.random().toString(36).slice(2,8));
        return id ? id : title;
      }, itemHandle);

      // open chat
      if (chatLinkSel) {
        const link = await itemHandle.$(chatLinkSel);
        if (link) await link.click();
        else await itemHandle.click();
      } else {
        await itemHandle.scrollIntoViewIfNeeded();
        await itemHandle.click();
      }

      await page.waitForTimeout(config.CLICK_DELAY_MS || 800);

      try {
        await page.waitForSelector(msgListSel, { timeout: 6000 });
      } catch (e) {
        console.warn('Сообщения не появились для chatKey=', chatKey);
        await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 300);
        continue;
      }

      await page.evaluate((sel) => {
        const list = document.querySelector(sel);
        if (list) list.scrollTop = list.scrollHeight;
      }, msgListSel);

      // extract messages
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
          const blocks = el.querySelectorAll('.attaches, .media, .fileIcon, .grid, .tile, .attach, .attachment');
          for (const b of blocks) {
            try {
              const img = b.querySelector('img');
              const url = img ? (img.src || img.getAttribute('data-src') || null) : null;
              const info = b.innerText ? b.innerText.trim() : null;
              const titleEl = b.querySelector('.title') || b.querySelector('.name') || null;
              const title = titleEl ? titleEl.innerText.trim() : null;
              res.push({ url, info, title });
            } catch (e) {}
          }
          return res;
        }

        return lastNodes.map(n => {
          if (n.classList && (n.classList.contains('dateSeparator') || n.classList.contains('date'))) {
            const dt = n.innerText ? n.innerText.trim() : null;
            return { type: 'date', date: dt };
          }
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
          if (!timeRaw) timeRaw = n.getAttribute('data-time') || n.getAttribute('data-ts') || n.getAttribute('title') || null;
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

      // prepare blocks
      const sendBlocks = [];

      for (const raw of rawMessages.slice().reverse()) {
        if (raw.type === 'date') continue;
        if (raw.type !== 'msg') continue;
        const hasContent = (raw.text && raw.text.trim().length) || (raw.attaches && raw.attaches.length);
        if (!hasContent) continue;

        // if id present and seen -> skip
        if (raw.id && seenSet.has(`${chatKey}|id:${raw.id}`)) continue;

        // attachments: download/placeholder logic
        const downloadable = [];
        const placeholders = [];
        if (raw.attaches && raw.attaches.length) {
          for (const att of raw.attaches) {
            const url = att.url;
            if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
              // no accessible URL -> placeholder
              const name = att.title || 'файл';
              placeholders.push({ type: 'file', filename: name, note: 'unavailable' });
              continue;
            }
            const info = await probeAndDownload(context.request, url);
            if (!info.ok) {
              if (info.reason === 'too_large') placeholders.push({ type: 'file', filename: info.filename || path.basename(url), note: 'too_large', size: info.size });
              else placeholders.push({ type: 'file', filename: info.filename || path.basename(url), note: 'unavailable' });
            } else {
              downloadable.push({ buffer: info.buffer, filename: info.filename, contentType: info.contentType, size: info.size, url: info.url });
            }
          }
        }

        // build image ids for hash (sha for downloaded; for placeholders add filename/url)
        const imgIds = [];
        for (const dl of downloadable) imgIds.push(hashSha256Buf(dl.buffer));
        for (const ph of placeholders) imgIds.push(`${ph.filename || 'file'}:${ph.note}`);

        const compositeHash = hashMessageComposite(chatKey, raw.id || null, raw.text || '', imgIds);
        if (seenSet.has(compositeHash)) continue;

        // mark as seen preemptively to avoid duplicates on long runs
        seenSet.add(compositeHash);

        // parts for message (html)
        const parts = [];
        const chatTitle = raw.chat || '—';
        const sender = raw.sender || null;
        const timeStr = raw.timeRaw ? (function parseTime(r){ try { const d = new Date(r); if (!isNaN(d)) return (new Intl.DateTimeFormat('sv-SE',{ timeZone:'Europe/Helsinki', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(d)).replace(',',''); } catch(e){} return r; })(raw.timeRaw) : null;

        // header lines
        parts.push(`<b>${escapeHtml(chatTitle)}</b>`);
        if (timeStr) parts.push(`<i>${escapeHtml(timeStr)}</i>`);
        if (sender) parts.push(`&quot;${escapeHtml(sender)}&quot;`);
        if (raw.text && raw.text.trim()) parts.push(escapeHtml(raw.text.trim()));

        sendBlocks.push({
          chatKey,
          id: raw.id,
          compositeHash,
          parts,
          images: downloadable, // actual images to send
          placeholders // info about too big/unavailable
        });
      } // end iterating messages

      // compute counts for this chat
      let newMessagesCount = sendBlocks.length;
      let photosCount = 0;
      let bigFilesCount = 0;
      for (const b of sendBlocks) {
        photosCount += (b.images ? b.images.length : 0);
        for (const ph of (b.placeholders || [])) {
          if (ph.note === 'too_large' || ph.note === 'unavailable') bigFilesCount++;
        }
      }

      if (newMessagesCount === 0) {
        console.log(`Чат ${chatKey}: новых сообщений не найдено.`);
      } else {
        console.log(`Чат ${chatKey}: найдено новых ${newMessagesCount} сообщений (${photosCount} фото, ${bigFilesCount} больших/недоступных).`);
      }

      // send each block, oldest-first
      for (const block of sendBlocks) {
        try {
          const captionHtml = block.parts.join('\n\n');
          // prepend summary for first block of this chat (only once per chat)
          // we will send summary in the first message for the chat
          // determine index of block to know if it's the first for this chat
          const isFirstBlockForChat = true; // we send per block; but we will add top summary only to first send
          // For simplicity, include counts as header to each block, but to avoid duplication:
          // we'll compose the summary text once per chat before first send. Simpler approach:
        } catch (e) {
          console.warn('Ошибка при подготовке к отправке блока:', e && e.message);
        }
      }

      // Instead of sending summary per block, we will send one combined message per chat that
      // contains summary and then per-block contents (to keep messages tidy).

      if (sendBlocks.length > 0) {
        // build one aggregated message per chat to preserve original behaviour of "chat once"
        const aggregateParts = [];
        // summary line
        aggregateParts.push(`<b>${escapeHtml(sendBlocks[0].parts[0] ? sendBlocks[0].parts[0].replace(/<b>|<\/b>/g,'') : 'Чат')}</b>`);
        aggregateParts.push(`Найдено новых: ${newMessagesCount} (фото: ${photosCount}, большие/недоступ.: ${bigFilesCount})`);
        aggregateParts.push(''); // spacer

        // then append each block textual parts and placeholders; images will be sent separately (media)
        const aggregatedImages = []; // images buffers to be sent as albums / photos
        const aggregatedPlaceholders = []; // placeholder lines to append as text

        for (const b of sendBlocks) {
          // include original header/time/sender/text
          const blockText = b.parts.join('\n\n');
          aggregateParts.push(blockText);

          // collect images
          if (b.images && b.images.length) {
            for (const img of b.images) aggregatedImages.push(img);
          }
          // placeholders -> compact text lines
          if (b.placeholders && b.placeholders.length) {
            for (const ph of b.placeholders) {
              if (ph.note === 'too_large') {
                const sizeMB = ph.size ? (Math.round((ph.size/1024/1024)*10)/10) : '>';
                aggregatedPlaceholders.push(`📎 Файл: ${escapeHtml(ph.filename)} (>50 MB) — откройте в Max`);
              } else {
                aggregatedPlaceholders.push(`📎 Файл: ${escapeHtml(ph.filename)} (недоступен) — откройте в Max`);
              }
            }
          }
          aggregateParts.push('──────────────'); // separator between messages
        }

        // final text that will be sent as a text message (summary + texts + placeholders)
        const finalText = aggregateParts.join('\n\n') + (aggregatedPlaceholders.length ? '\n\n' + aggregatedPlaceholders.join('\n') : '');

        // send text summary first (or as caption with first image)
        try {
          if (aggregatedImages.length === 0) {
            // just text
            await sendTelegramTextHTML(finalText);
          } else if (aggregatedImages.length === 1) {
            // single image + caption
            const img = aggregatedImages[0];
            const caption = finalText.length > 1000 ? finalText.slice(0,1000) : finalText;
            try {
              await sendPhotoBuffer(img.buffer, img.filename, img.contentType, caption);
            } catch (e) {
              // fallback to text + placeholder
              await sendTelegramTextHTML(finalText + '\n\n📎 Некоторые файлы не отправлены (см. выше).');
            }
          } else {
            // multiple images: send in chunks of 10 as media groups
            // For the first group include caption (summary)
            const chunks = [];
            for (let i = 0; i < aggregatedImages.length; i += 10) {
              chunks.push(aggregatedImages.slice(i, i + 10));
            }
            for (let ci = 0; ci < chunks.length; ci++) {
              const pack = chunks[ci].map((p, ii) => ({ buffer: p.buffer, name: p.filename || `img_${ci}_${ii}.jpg`, contentType: p.contentType }));
              const caption = (ci === 0 ? (finalText.length > 1000 ? finalText.slice(0,1000) : finalText) : '');
              try {
                await sendMediaGroupBuffers(pack, caption);
              } catch (e) {
                // on failure send text + note
                await sendTelegramTextHTML(finalText + '\n\n📎 Некоторые файлы не отправлены (см. выше).');
                break;
              }
              await page.waitForTimeout(400);
            }
          }
        } catch (e) {
          console.warn('Ошибка отправки агрегированного сообщения в Telegram:', e && e.message);
        }
      } // end if sendBlocks.length>0

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
