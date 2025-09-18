// checker.js — обновлённый: фикс рендера HTML, улучшенный парсер вложений,
// дедупликация изображений, корректная пометка seen (id + composite hash)
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

// helpers
function loadLastSeen() {
  if (fs.existsSync(LAST_SEEN_PATH)) {
    try { return JSON.parse(fs.readFileSync(LAST_SEEN_PATH, 'utf8')); }
    catch (e) { return { chats: {} }; }
  }
  return { chats: {} };
}
function saveLastSeen(obj) {
  try { fs.writeFileSync(LAST_SEEN_PATH, JSON.stringify(obj, null, 2)); }
  catch (e) { console.warn('Не удалось записать last_seen.json', e && e.message); }
}
function hashSha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function hashMessageComposite(chatKey, id, text, imgIds = []) {
  if (id) return `${chatKey}|id:${id}`;
  const payload = `${chatKey}|text:${text || ''}|imgs:${imgIds.join(',')}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Telegram senders — ensure parse_mode: HTML everywhere
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
  fd.append('parse_mode', 'HTML');
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

async function sendMediaGroupBuffers(buffers /* [{buffer, name, contentType}] */, captionFirst) {
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  fd.append('parse_mode', 'HTML');
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

// Playwright download (uses context.request)
async function probeAndDownload(ctxRequest, url) {
  try {
    const resp = await ctxRequest.get(url, { timeout: 30000 });
    if (!resp.ok()) return { ok: false, reason: 'http_error', status: resp.status(), url };
    const headers = resp.headers();
    const ct = headers['content-type'] || 'application/octet-stream';
    const cl = headers['content-length'] ? Number(headers['content-length']) : null;
    let filename = null;
    if (headers['content-disposition']) {
      const m = headers['content-disposition'].match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
      if (m) filename = decodeURIComponent(m[1]);
    }
    if (!filename) {
      try { filename = path.basename((new URL(url)).pathname) || null; } catch(e){ filename = null; }
    }
    if (!filename) filename = `file_${Date.now()}`;
    if (cl && cl > ATTACH_SIZE_LIMIT) return { ok: false, reason: 'too_large', size: cl, contentType: ct, filename, url };
    const buf = await resp.body();
    if (!buf) return { ok: false, reason: 'no_body', url };
    if (buf.length > ATTACH_SIZE_LIMIT) return { ok: false, reason: 'too_large', size: buf.length, contentType: ct, filename, url };
    return { ok: true, buffer: buf, size: buf.length, contentType: ct, filename, url };
  } catch (e) {
    return { ok: false, reason: 'exception', error: e.message, url };
  }
}

// improved helper to test if an href looks like a file/image link
function looksLikeFileUrl(href) {
  if (!href) return false;
  try {
    const u = href.toLowerCase();
    if (u.includes('download') || u.includes('/file/') || u.includes('/uploads/') ) return true;
    if (u.match(/\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|mp4|pdf|zip)(?:$|\?)/)) return true;
    return false;
  } catch (e) { return false; }
}

// --- main ---
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
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

      // extract messages with stricter attach detection
      const rawMessages = await page.evaluate((cfg) => {
        const { msgListSel, msgItemSel, msgTextSel, msgTimeSel, chatTitleSel, maxLast } = cfg;
        const container = document.querySelector(msgListSel);
        if (!container) return [];
        const nodes = Array.from(container.querySelectorAll(msgItemSel));
        const lastNodes = maxLast ? nodes.slice(-maxLast) : nodes;
        const chatEl = document.querySelector(chatTitleSel);
        const chatName = chatEl ? chatEl.innerText.trim() : '—';

        function looksLikeFileBlock(b) {
          // consider a block an attachment only if it contains an <img> OR an <a href> that looks like file
          if (!b) return false;
          if (b.querySelector && b.querySelector('img')) return true;
          const a = b.querySelector && b.querySelector('a[href]');
          if (a && a.href) {
            const href = a.href.toLowerCase();
            if (href.includes('download') || href.includes('/file/') || href.includes('/uploads/') ) return true;
            if (href.match(/\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|mp4|pdf|zip)(?:$|\?)/)) return true;
          }
          // check inner text for "Скачать" or size pattern KB/MB
          const t = b.innerText ? b.innerText.toLowerCase() : '';
          if (t.includes('скачать') || t.match(/[\d.,]+\s*(kb|mb|b)/)) return true;
          return false;
        }

        function extractAttachmentsStrict(el) {
          const res = [];
          // possible attachment wrappers
          const blocks = el.querySelectorAll('.attaches, .media, .fileIcon, .grid, .tile, .attach, .attachment, a[href]');
          for (const b of blocks) {
            try {
              if (!looksLikeFileBlock(b)) continue;
              const img = b.querySelector('img');
              const url = img ? (img.src || img.getAttribute('data-src') || null) : (b.querySelector('a[href]') ? b.querySelector('a[href]').href : null);
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
          const attaches = extractAttachmentsStrict(n);
          return { type: 'msg', id, chat: chatName, text, timeRaw, sender, attaches };
        });
      }, { msgListSel, msgItemSel, msgTextSel, msgTimeSel, chatTitleSel, maxLast: MAX_LAST_MESSAGES });

      if (!lastSeen.chats[chatKey]) lastSeen.chats[chatKey] = [];
      const seenSet = new Set(lastSeen.chats[chatKey]);

      const sendBlocks = [];

      for (const raw of rawMessages.slice().reverse()) {
        if (raw.type === 'date') continue;
        if (raw.type !== 'msg') continue;
        const hasContent = (raw.text && raw.text.trim().length) || (raw.attaches && raw.attaches.length);
        if (!hasContent) continue;

        // skip by explicit id if already seen
        if (raw.id && seenSet.has(`${chatKey}|id:${raw.id}`)) continue;

        const downloadable = [];
        const placeholders = [];
        if (raw.attaches && raw.attaches.length) {
          for (const att of raw.attaches) {
            const url = att.url;
            if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
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

        // build ids from images and placeholders for composite hash
        const imgIds = [];
        for (const dl of downloadable) imgIds.push(hashSha256Buf(dl.buffer));
        for (const ph of placeholders) imgIds.push(`${ph.filename || 'file'}:${ph.note}`);

        const compositeHash = hashMessageComposite(chatKey, raw.id || null, raw.text || '', imgIds);
        if (seenSet.has(compositeHash)) continue;

        // conservative: mark both id marker and composite hash
        if (raw.id) seenSet.add(`${chatKey}|id:${raw.id}`);
        seenSet.add(compositeHash);

        const parts = [];
        const chatTitle = raw.chat || '—';
        const sender = raw.sender || null;
        const timeStr = raw.timeRaw ? (function parseTime(r){ try { const d = new Date(r); if (!isNaN(d)) return (new Intl.DateTimeFormat('sv-SE',{ timeZone:'Europe/Helsinki', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(d)).replace(',',''); } catch(e){} return r; })(raw.timeRaw) : null;

        parts.push(`<b>${escapeHtml(chatTitle)}</b>`);
        if (timeStr) parts.push(`<i>${escapeHtml(timeStr)}</i>`);
        if (sender) parts.push(`&quot;${escapeHtml(sender)}&quot;`);
        if (raw.text && raw.text.trim()) parts.push(escapeHtml(raw.text.trim()));

        sendBlocks.push({
          chatKey,
          id: raw.id,
          compositeHash,
          parts,
          images: downloadable,
          placeholders
        });
      }

      // counts
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

      // aggregate one message per chat: summary + texts + placeholders; images sent as albums
      if (sendBlocks.length > 0) {
        const aggregateParts = [];
        // chat title (bold) from first block (parts[0] contains bolded title)
        const firstTitleHtml = sendBlocks[0].parts[0] || `<b>${escapeHtml('Чат')}</b>`;
        // ensure we don't double-escape: firstTitleHtml already contains <b>escapedTitle</b>
        aggregateParts.push(firstTitleHtml);
        aggregateParts.push(`Найдено новых: ${newMessagesCount} (фото: ${photosCount}, большие/недоступ.: ${bigFilesCount})`);
        aggregateParts.push('');

        const aggregatedImages = [];
        const aggregatedPlaceholders = [];
        // use Map for deduplication by hash
        const seenImageHashes = new Map();

        for (const b of sendBlocks) {
          const blockText = b.parts.join('\n\n');
          aggregateParts.push(blockText);

          if (b.images && b.images.length) {
            for (const img of b.images) {
              const h = hashSha256Buf(img.buffer);
              if (!seenImageHashes.has(h)) {
                seenImageHashes.set(h, img);
                aggregatedImages.push(img);
              } // else duplicate -> skip
            }
          }

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
          aggregateParts.push('──────────────');
        }

        const finalText = aggregateParts.join('\n\n') + (aggregatedPlaceholders.length ? '\n\n' + aggregatedPlaceholders.join('\n') : '');

        // send
        try {
          if (aggregatedImages.length === 0) {
            await sendTelegramTextHTML(finalText);
          } else if (aggregatedImages.length === 1) {
            const img = aggregatedImages[0];
            const caption = finalText.length > 1000 ? finalText.slice(0,1000) : finalText;
            try { await sendPhotoBuffer(img.buffer, img.filename, img.contentType, caption); }
            catch (e) { await sendTelegramTextHTML(finalText + '\n\n📎 Некоторые файлы не отправлены (см. выше).'); }
          } else {
            // send in chunks of 10
            for (let i = 0; i < aggregatedImages.length; i += 10) {
              const pack = aggregatedImages.slice(i, i + 10).map((p, ii) => ({ buffer: p.buffer, name: p.filename || `img_${i+ii}.jpg`, contentType: p.contentType }));
              const caption = (i === 0 ? (finalText.length > 1000 ? finalText.slice(0,1000) : finalText) : '');
              try { await sendMediaGroupBuffers(pack, caption); }
              catch (e) { await sendTelegramTextHTML(finalText + '\n\n📎 Некоторые файлы не отправлены (см. выше).'); break; }
              await page.waitForTimeout(400);
            }
          }
        } catch (e) {
          console.warn('Ошибка отправки агрегированного сообщения в Telegram:', e && e.message);
        }
      }

      // persist seen for this chat
      lastSeen.chats[chatKey] = Array.from(seenSet).slice(-MAX_HASH_STORE);
      saveLastSeen(lastSeen);

      await page.waitForTimeout(config.PER_CHAT_PAUSE_MS || 400);

    } catch (err) {
      console.warn('Ошибка при обработке чата index', idx, (err && err.stack) ? err.stack : err);
    }
  }

  try {
    await context.storageState({ path: STORAGE_PATH });
    console.log('Обновлён storageState.json');
  } catch (e) { console.warn('Не удалось сохранить storageState:', e && e.message); }

  await browser.close();
  console.log('Done.');
  process.exit(0);
})().catch(e => {
  console.error('Fatal error in checker.js:', e && e.stack ? e.stack : e);
  process.exit(1);
});
