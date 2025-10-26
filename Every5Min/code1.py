import json
import time
import asyncio
from playwright.async_api import async_playwright
import requests
import logging
import os
import re
from hashlib import sha256

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

CONFIG_FILE = 'config.json'
STATE_FILE = 'storageState.json'
SCREENSHOT_FILE = 'temp_screenshot.png'

# --- Селекторы ---
ITEM_SELECTOR = 'div.item[data-index]'
MESSAGE_BUBBLE_SELECTOR = 'div[class*="bubble"]' 
MEDIA_SELECTOR = 'div.media'
ATTACHMENT_SELECTOR = 'div.attaches'
REGULAR_MESSAGE_WRAPPER = 'div.messageWrapper:not(.messageWrapper--control)'
SENDER_NAME_SELECTOR = 'span.name'
SYSTEM_MESSAGE_WRAPPER = 'div.messageWrapper--control'
SYSTEM_TEXT_SELECTOR = 'div.message'

def load_config():
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f: return json.load(f)
    except Exception as e:
        logging.error(f"Ошибка загрузки {CONFIG_FILE}: {e}. Завершение работы."); exit()

def parse_chats_from_config(config):
    chats = []
    for key, value in config.items():
        if key.startswith("VK_MESSAGES_URL_"):
            parts = key.split('_', 4)
            if len(parts) < 5: continue
            chat_type, name = parts[3], parts[4]
            is_group = True if chat_type.upper() == 'GROUP' else False
            chats.append({"name": name, "url": value, "is_group_chat": is_group})
    return chats

def get_cache_filename(chat_name):
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '', chat_name)
    return f"cache_{safe_name}.json"

def load_local_cache(chat_name):
    cache_file = get_cache_filename(chat_name)
    if not os.path.exists(cache_file): return set()
    try:
        with open(cache_file, 'r', encoding='utf-8') as f: return set(f.read().splitlines())
    except Exception: return set()

def save_local_cache(chat_name, hashes):
    cache_file = get_cache_filename(chat_name)
    with open(cache_file, 'w', encoding='utf-8') as f:
        f.write("\n".join(hashes))

def send_telegram_message(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'HTML'}
    try:
        requests.post(url, json=payload, timeout=15).raise_for_status()
        logging.info("Текстовое сообщение отправлено.")
    except requests.exceptions.RequestException as e:
        logging.error(f"Ошибка отправки текста: {e}")

def send_telegram_screenshot(token, chat_id, caption):
    url = f"https://api.telegram.org/bot{token}/sendPhoto"
    try:
        with open(SCREENSHOT_FILE, 'rb') as photo_file:
            files = {'photo': (SCREENSHOT_FILE, photo_file, 'image/png')}
            payload = {'chat_id': chat_id, 'caption': caption, 'parse_mode': 'HTML'}
            response = requests.post(url, data=payload, files=files, timeout=30)
            response.raise_for_status()
        logging.info("Скриншот успешно отправлен.")
    except requests.exceptions.RequestException as e:
        logging.error(f"Ошибка отправки скриншота: {e}")
    finally:
        if os.path.exists(SCREENSHOT_FILE):
            os.remove(SCREENSHOT_FILE)

async def scrape_and_identify(page, is_group_chat):
    await page.wait_for_selector(ITEM_SELECTOR, timeout=30000)
    await page.wait_for_timeout(2000)

    identified_messages = []
    items = await page.query_selector_all(ITEM_SELECTOR)
    last_sender = "Unknown"
    
    for item in items[-50:]:
        unique_content = await item.inner_html()
        content_hash = sha256(unique_content.encode()).hexdigest()
        
        system_wrapper = await item.query_selector(SYSTEM_MESSAGE_WRAPPER)
        if system_wrapper:
            text_el = await system_wrapper.query_selector(SYSTEM_TEXT_SELECTOR)
            text = (await text_el.inner_text()).strip() if text_el else ""
            if text:
                identified_messages.append({'hash': content_hash, 'type': 'system', 'text': text})
            continue

        is_media = await item.query_selector(MEDIA_SELECTOR)
        is_attachment = await item.query_selector(ATTACHMENT_SELECTOR)
        if is_media or is_attachment:
            identified_messages.append({'hash': content_hash, 'type': 'media', 'element': item})
            sender_name_el = await item.query_selector(SENDER_NAME_SELECTOR)
            if sender_name_el:
                last_sender = (await sender_name_el.inner_text()).strip()
            continue
        
        regular_wrapper = await item.query_selector(REGULAR_MESSAGE_WRAPPER)
        if regular_wrapper:
            sender_text = "Direct"
            sender_name_el = await regular_wrapper.query_selector(SENDER_NAME_SELECTOR)
            if is_group_chat and sender_name_el:
                last_sender = (await sender_name_el.inner_text()).strip()
                sender_text = last_sender
            elif is_group_chat:
                sender_text = last_sender
            
            bubble = await regular_wrapper.query_selector(MESSAGE_BUBBLE_SELECTOR)
            if not bubble: continue

            full_text_content = (await bubble.inner_text()).strip()
            text_parts = full_text_content.split('\n')
            
            message_text = "\n".join(part for part in text_parts if not (
                part == sender_text or
                part == "владелец" or
                re.fullmatch(r'\d{2}:\d{2}( ред.)?', part)
            )).strip()
            
            if message_text:
                identified_messages.append({'hash': content_hash, 'type': 'text', 'text': message_text, 'sender': sender_text})
    
    logging.info(f"Идентифицировано {len(identified_messages)} сообщений на странице.")
    return identified_messages

async def process_single_chat(chat_config, tg_token, tg_chat_id, playwright_instance):
    chat_name, chat_url, is_group = chat_config['name'], chat_config['url'], chat_config['is_group_chat']
    logging.info(f"--- Проверка чата: {chat_name} ---")
    
    cached_hashes = load_local_cache(chat_name)
    
    try:
        browser = await playwright_instance.chromium.launch(headless=True)
        context = await browser.new_context(
            storage_state=STATE_FILE,
            device_scale_factor=2,
            viewport={'width': 1280, 'height': 720}
        )
        page = await context.new_page()
        await page.goto(chat_url, wait_until='domcontentloaded', timeout=60000)
        
        identified_messages = await scrape_and_identify(page, is_group)
        
        new_messages = [msg for msg in identified_messages if msg['hash'] not in cached_hashes]

        if new_messages:
            logging.info(f"Найдено {len(new_messages)} новых сообщений.")
            for msg in new_messages:
                if msg['type'] == 'media':
                    logging.info("Найдено медиа-сообщение, делаю скриншот...")
                    message_bubble = await msg['element'].query_selector(MESSAGE_BUBBLE_SELECTOR)
                    if message_bubble:
                        # --- ИЗМЕНЕНИЕ: УВЕЛИЧИВАЕМ ПАУЗУ ДО 2 СЕКУНД ---
                        await asyncio.sleep(2) 
                        await message_bubble.screenshot(path=SCREENSHOT_FILE)
                        caption = f"<i>(Новое в чате '{chat_name}')</i>"
                        send_telegram_screenshot(tg_token, tg_chat_id, caption)
                
                elif msg['type'] == 'text':
                    sender, text = msg['sender'], msg['text']
                    full_message = f"<b>{sender}</b> (<i>{chat_name}</i>):\n{text}" if is_group and sender != "Direct" else text
                    send_telegram_message(tg_token, tg_chat_id, full_message)

                elif msg['type'] == 'system':
                    text = msg['text']
                    full_message = f"<i>(Системное сообщение в '{chat_name}')</i>\n{text}"
                    send_telegram_message(tg_token, tg_chat_id, full_message)
        else:
            logging.info("Новых сообщений не найдено.")

        current_hashes = [msg['hash'] for msg in identified_messages]
        save_local_cache(chat_name, current_hashes)
        await browser.close()
    except Exception as e:
        logging.error(f"Критическая ошибка в '{chat_name}': {e}"); return

async def main():
    logging.info("Запуск v4 (увеличенная задержка скриншота).")
    config = load_config()
    chats_to_process = parse_chats_from_config(config)
    
    if not chats_to_process:
        logging.error("В config.json не найдено чатов."); return

    tg_token, tg_chat_id = config['TELEGRAM_BOT_TOKEN'], config['TELEGRAM_CHAT_ID']
    check_interval = config.get('CHECK_INTERVAL_SECONDS', 300)

    async with async_playwright() as p:
        while True:
            for chat_config in chats_to_process:
                await process_single_chat(chat_config, tg_token, tg_chat_id, p)
            logging.info(f"--- Проверка завершена. Пауза на {check_interval} секунд. ---")
            time.sleep(check_interval)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Скрипт остановлен вручную.")
