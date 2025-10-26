import json
import time
import asyncio
from playwright.async_api import async_playwright
import requests
import logging
import os
import re

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

CONFIG_FILE = 'config.json'
STATE_FILE = 'storageState.json'

# --- CSS Селекторы (финальная версия) ---
ITEM_SELECTOR = 'div.item[data-index]'
# Обычные сообщения
REGULAR_MESSAGE_WRAPPER = 'div.messageWrapper:not(.messageWrapper--control)'
SENDER_SELECTOR = 'span.name'
TEXT_SELECTOR = 'span.text.svelte-1htnb3l'
PHOTO_SELECTOR = 'img.image'
# Вложения файлов
FILE_ATTACHMENT_SELECTOR = 'div.attaches'
FILENAME_SELECTOR = 'div.title.svelte-1cw64r4'
# Системные сообщения
SYSTEM_MESSAGE_WRAPPER = 'div.messageWrapper--control'
SYSTEM_TEXT_SELECTOR = 'div.message.svelte-fxkkld'

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
    if not os.path.exists(cache_file): return []
    try:
        with open(cache_file, 'r', encoding='utf-8') as f: return json.load(f)
    except Exception: return []

def save_local_cache(chat_name, messages):
    cache_file = get_cache_filename(chat_name)
    with open(cache_file, 'w', encoding='utf-8') as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)

def send_telegram_message(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {'chat_id': chat_id, 'text': text, 'parse_mode': 'HTML'}
    try:
        requests.post(url, json=payload, timeout=10).raise_for_status()
        logging.info("Текстовое сообщение отправлено.")
    except requests.exceptions.RequestException as e:
        logging.error(f"Ошибка отправки текста: {e}")

def send_telegram_photo(token, chat_id, photo_url, caption):
    url = f"https://api.telegram.org/bot{token}/sendPhoto"
    payload = {'chat_id': chat_id, 'photo': photo_url, 'caption': caption, 'parse_mode': 'HTML'}
    try:
        requests.post(url, json=payload, timeout=20).raise_for_status()
        logging.info("Фотография отправлена.")
    except requests.exceptions.RequestException as e:
        logging.error(f"Ошибка отправки фото: {e}")

def send_telegram_photo_album(token, chat_id, photo_urls, caption):
    url = f"https://api.telegram.org/bot{token}/sendMediaGroup"
    media = []
    for i, photo_url in enumerate(photo_urls):
        item = {'type': 'photo', 'media': photo_url}
        if i == 0:  # Подпись можно добавить только к первому элементу
            item['caption'] = caption
            item['parse_mode'] = 'HTML'
        media.append(item)
    
    payload = {'chat_id': chat_id, 'media': media}
    try:
        requests.post(url, json=payload, timeout=30).raise_for_status()
        logging.info(f"Альбом из {len(photo_urls)} фото отправлен.")
    except requests.exceptions.RequestException as e:
        logging.error(f"Ошибка отправки альбома: {e}")

async def scrape_messages(page, is_group_chat):
    await page.wait_for_timeout(2000)
    for _ in range(5):
        await page.keyboard.press('PageUp')
        await page.wait_for_timeout(500)

    scraped_data = []
    items = await page.query_selector_all(ITEM_SELECTOR)

    for item in items:
        # 1. Проверка на ОБЫЧНОЕ сообщение (текст, фото, файлы)
        regular_wrapper = await item.query_selector(REGULAR_MESSAGE_WRAPPER)
        if regular_wrapper:
            sender = "Direct"
            if is_group_chat:
                sender_el = await regular_wrapper.query_selector(SENDER_SELECTOR)
                if sender_el: sender = (await sender_el.inner_text()).strip()

            text_el = await regular_wrapper.query_selector(TEXT_SELECTOR)
            text = (await text_el.inner_text()).strip() if text_el else ""
            
            # Ищем ВСЕ фото в сообщении
            photo_els = await regular_wrapper.query_selector_all(PHOTO_SELECTOR)
            photo_urls = [await photo.get_attribute('src') for photo in photo_els]

            # Ищем вложения файлов
            file_el = await regular_wrapper.query_selector(FILE_ATTACHMENT_SELECTOR)
            if file_el:
                filename_el = await file_el.query_selector(FILENAME_SELECTOR)
                filename = (await filename_el.inner_text()).strip() if filename_el else "имя не найдено"
                # Добавляем информацию о файле к тексту
                file_notification = f"[Прислан файл: {filename}]"
                text = f"{text}\n{file_notification}" if text else file_notification

            if text or photo_urls:
                scraped_data.append({"sender": sender, "text": text.strip(), "photo_urls": photo_urls})
            continue

        # 2. Проверка на СИСТЕМНОЕ сообщение
        system_wrapper = await item.query_selector(SYSTEM_MESSAGE_WRAPPER)
        if system_wrapper:
            text_el = await system_wrapper.query_selector(SYSTEM_TEXT_SELECTOR)
            if text_el:
                text = (await text_el.inner_text()).strip()
                if text: scraped_data.append({"sender": "System", "text": text, "photo_urls": []})
            continue
            
    logging.info(f"Собрано {len(scraped_data)} элементов контента.")
    return scraped_data

async def process_single_chat(chat_config, tg_token, tg_chat_id):
    chat_name, chat_url, is_group = chat_config['name'], chat_config['url'], chat_config['is_group_chat']
    logging.info(f"--- Проверка чата: {chat_name} ---")
    
    cached_messages = load_local_cache(chat_name)
    cached_set = set(json.dumps(msg) for msg in cached_messages)
    
    scraped_messages = []
    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(storage_state=STATE_FILE)
            page = await context.new_page()
            await page.goto(chat_url, wait_until='networkidle', timeout=60000)
            scraped_messages = await scrape_messages(page, is_group)
        except Exception as e:
            logging.error(f"Ошибка Playwright в '{chat_name}': {e}"); return
        finally:
            if 'browser' in locals() and browser.is_connected(): await browser.close()

    if not scraped_messages: return

    new_messages = [msg for msg in scraped_messages if json.dumps(msg) not in cached_set]

    if new_messages:
        logging.info(f"Найдено {len(new_messages)} новых элементов в '{chat_name}'.")
        for msg in new_messages:
            sender, text, photo_urls = msg['sender'], msg['text'], msg['photo_urls']
            
            # Формируем базовую подпись/сообщение
            base_caption = ""
            if sender == "System": base_caption = f"<i>(Системное сообщение в '{chat_name}')</i>"
            elif is_group: base_caption = f"<b>{sender}</b> (<i>{chat_name}</i>)"
            
            final_text = f"{base_caption}\n{text}" if base_caption and text else base_caption or text

            # Решаем, как отправлять
            if len(photo_urls) > 1:
                send_telegram_photo_album(tg_token, tg_chat_id, photo_urls, final_text)
            elif len(photo_urls) == 1:
                send_telegram_photo(tg_token, tg_chat_id, photo_urls[0], final_text)
            elif text:
                send_telegram_message(tg_token, tg_chat_id, final_text)
    else:
        logging.info(f"Новых элементов в '{chat_name}' не найдено.")

    save_local_cache(chat_name, scraped_messages)

async def main():
    logging.info("Запуск универсального форвардера.")
    config = load_config()
    chats_to_process = parse_chats_from_config(config)
    
    if not chats_to_process:
        logging.error("В config.json не найдено чатов."); return

    logging.info("--- Будут отслеживаться чаты: ---")
    for chat in chats_to_process:
        logging.info(f"  - {chat['name']} (Тип: {'Групповой' if chat['is_group_chat'] else 'Личный'})")
    
    tg_token, tg_chat_id = config['TELEGRAM_BOT_TOKEN'], config['TELEGRAM_CHAT_ID']
    check_interval = config.get('CHECK_INTERVAL_SECONDS', 300)

    while True:
        for chat_config in chats_to_process:
            await process_single_chat(chat_config, tg_token, tg_chat_id)
        logging.info(f"--- Проверка завершена. Пауза на {check_interval} секунд. ---")
        time.sleep(check_interval)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Скрипт остановлен вручную.")
