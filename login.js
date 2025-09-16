// login.js
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const MAX_WEB = require('./config.json').MAX_WEB;
  console.log('Запускаю браузер для первичного логина. Откроется окно — выполните вход вручную.');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(MAX_WEB, { waitUntil: 'networkidle' });

  console.log('Когда выполните ручной вход (SMS/OTP), вернитесь сюда и нажмите Enter.');
  await new Promise(resolve => process.stdin.once('data', resolve));

  // Сохраняем storageState.json
  await context.storageState({ path: 'storageState.json' });
  console.log('Сохранено storageState.json — поместите его в безопасное место для шифрования/дальнейшего использования.');

  await browser.close();
})();
