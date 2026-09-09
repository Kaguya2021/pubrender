require('dotenv').config();
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');
const storage = require('./storage');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Твой Telegram ID — у админа виден список сервисов ВСЕХ пользователей.
// Можно переопределить через переменную окружения ADMIN_ID.
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10) || 6511859639;

if (!BOT_TOKEN) {
  console.error('❌ Ошибка: Не указан BOT_TOKEN в файле .env или переменных окружения!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Хранилище отслеживаемых сервисов в памяти (для скорости).
// Ключ — короткий уникальный id сервиса (НЕ url), т.к. один и тот же url
// может отслеживаться разными пользователями независимо друг от друга.
// { id, url, ownerId, ownerName, intervalMinutes, timerId, chatId, status, lastCheck }
const services = new Map();

// Состояния пользователя для ввода данных (waiting_for_url / waiting_for_interval)
const userStates = new Map();

// --- СЕРВЕР ДЛЯ РЕНДЕРА (Чтобы не засыпал) ---
const app = express();
app.get('/', (req, res) => res.send('🚀 Ping Bot is active and running!'));
app.listen(PORT, () => console.log(`🌐 Web Server running on port ${PORT}`));

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

function isAdmin(userId) {
  return userId === ADMIN_ID;
}

function generateId() {
  let id;
  do {
    id = crypto.randomBytes(4).toString('hex');
  } while (services.has(id));
  return id;
}

function serialize(service) {
  return {
    id: service.id,
    ownerId: service.ownerId,
    ownerName: service.ownerName || '',
    chatId: service.chatId,
    url: service.url,
    intervalMinutes: service.intervalMinutes,
    status: service.status,
    lastCheck: service.lastCheck
  };
}

function persist(service) {
  storage.upsert(serialize(service)).catch((err) =>
    console.error('⚠️ Ошибка сохранения сервиса:', err.message)
  );
}

// Сервисы, видимые данному пользователю: свои + все, если это админ
function visibleServices(userId) {
  const all = Array.from(services.values());
  if (isAdmin(userId)) return all;
  return all.filter((s) => s.ownerId === userId);
}

function ownsOrAdmin(service, userId) {
  return !!service && (service.ownerId === userId || isAdmin(userId));
}

// --- ФУНКЦИИ ПИНГА И МОНИТОРИНГА ---

async function pingService(id) {
  const service = services.get(id);
  if (!service) return;

  const startTime = Date.now();
  try {
    await axios.get(service.url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const responseTime = Date.now() - startTime;

    service.status = `🟢 200 OK (${responseTime}ms)`;
    service.lastCheck = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    const statusCode = err.response ? `HTTP ${err.response.status}` : 'No Response';

    service.status = `🔴 Fail (${statusCode})`;
    service.lastCheck = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    // Отправляем алерт при падении владельцу сервиса
    bot.telegram.sendMessage(
      service.chatId,
      `🚨 *СЕРВИС НЕ ОТВЕЧАЕТ!*\n\n🔗 *URL:* ${service.url}\n❌ *Ошибка:* ${statusCode} / ${err.message}\n⏰ *Время:* ${new Date().toLocaleTimeString('ru-RU')}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  persist(service);
}

function startTimer({ id, url, minutes, chatId, ownerId, ownerName, status, lastCheck }) {
  const existing = services.get(id);
  if (existing && existing.timerId) {
    clearInterval(existing.timerId);
  }

  const service = {
    id,
    url,
    ownerId,
    ownerName: ownerName || (existing && existing.ownerName) || '',
    intervalMinutes: minutes,
    chatId,
    status: status || '⏳ Проверяется...',
    lastCheck: lastCheck || 'Только что',
    timerId: null
  };

  services.set(id, service);
  persist(service);

  // Запускаем первый пинг сразу
  pingService(id);

  // Интервал в миллисекундах
  service.timerId = setInterval(() => {
    pingService(id);
  }, minutes * 60 * 1000);
}

function stopTimer(id) {
  const service = services.get(id);
  if (service && service.timerId) {
    clearInterval(service.timerId);
  }
  services.delete(id);
  storage.remove(id).catch((err) => console.error('⚠️ Ошибка удаления сервиса:', err.message));
}

async function restoreServices() {
  const saved = await storage.getAll();
  for (const rec of saved) {
    // При восстановлении статус подхватится при первом же пинге
    startTimer({
      id: rec.id,
      url: rec.url,
      minutes: rec.intervalMinutes,
      chatId: rec.chatId,
      ownerId: rec.ownerId,
      ownerName: rec.ownerName,
      status: rec.status,
      lastCheck: rec.lastCheck
    });
  }
  if (saved.length > 0) {
    console.log(`♻️ Восстановлено сервисов из хранилища: ${saved.length}`);
  }
}

// --- КНОПКИ И ИНТЕРФЕЙС ---

function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Мои сервисы', 'list_services')],
    [Markup.button.callback('➕ Добавить сервис', 'add_service'), Markup.button.callback('⚡ Пинг всех', 'ping_now')],
    [Markup.button.callback('ℹ️ Инфо и Помощь', 'help_info')]
  ]);
}

function ownerLabel(service) {
  if (service.ownerName) return `@${service.ownerName}`;
  return `ID ${service.ownerId}`;
}

function buildServicesView(userId) {
  const list = visibleServices(userId);
  const admin = isAdmin(userId);

  if (list.length === 0) {
    return {
      text: admin
        ? '📭 Пока никто не добавил ни одного сервиса.'
        : '📭 У вас пока нет отслеживаемых сервисов.',
      buttons: [
        [Markup.button.callback('➕ Добавить сервис', 'add_service')],
        [Markup.button.callback('🔙 Назад', 'main_menu')]
      ]
    };
  }

  let messageText = admin
    ? '👑 *Все сервисы всех пользователей:*\n\n'
    : '📋 *Ваши отслеживаемые сервисы:*\n\n';

  const buttons = [];

  list.forEach((val) => {
    let domain = val.url;
    try { domain = new URL(val.url).hostname; } catch (e) {}

    messageText += `${val.status}\n🔗 ${val.url}\n⏱ Интервал: *${val.intervalMinutes} мин.* | Проверка: *${val.lastCheck}*`;
    if (admin) {
      messageText += `\n👤 Владелец: ${ownerLabel(val)}`;
    }
    messageText += '\n\n';

    const label = admin ? `⚙️ ${domain} (${ownerLabel(val)})` : `⚙️ ${domain}`;
    buttons.push([Markup.button.callback(label, `manage_${val.id}`)]);
  });

  buttons.push([Markup.button.callback('🔙 Назад в меню', 'main_menu')]);

  return { text: messageText, buttons };
}

// --- ОБРАБОТЧИКИ КОМАНД И КНОПОК ---

bot.start((ctx) => {
  ctx.reply(
    `👋 *Привет! Я бот-пингер для Render и любых сайтов.*\n\n` +
    `Я могу регулярно проверять доступность ваших веб-сервисов и присылать предупреждения, если сервис упадет.\n\n` +
    `🔒 Все добавленные ссылки видны только вам — другие пользователи бота их не видят.`,
    { parse_mode: 'Markdown', ...getMainMenu() }
  );
});

// Главное меню
bot.action('main_menu', (ctx) => {
  userStates.delete(ctx.from.id);
  ctx.editMessageText('🛠 *Главное меню:*', { parse_mode: 'Markdown', ...getMainMenu() });
});

// Информация
bot.action('help_info', (ctx) => {
  ctx.editMessageText(
    `ℹ️ *Информация*\n\n` +
    `• Добавляйте ссылки на Render, Vercel, VPS или обычные сайты.\n` +
    `• Указывайте дефолтный таймер (например 5-10 мин) или свой кастомный.\n` +
    `• Если сервис выдаст ошибку или перестанет отвечать, бот пришлет алерт.\n` +
    `• 🔒 Ваши сервисы видны только вам — у каждого пользователя своя личная граница.\n\n` +
    `💡 *Чтобы бот на Render не засыпал*, зарегистрируйте URL созданного бота в бесплатных сервисах вроде UptimeRobot (каждые 10 мин).`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]])
    }
  );
});

// Список сервисов (кнопкой)
bot.action('list_services', (ctx) => {
  const { text, buttons } = buildServicesView(ctx.from.id);
  ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons)
  });
});

// Список сервисов (текстовой командой "мои сервисы")
bot.hears(/мои\s*сервис/i, (ctx) => {
  const { text, buttons } = buildServicesView(ctx.from.id);
  ctx.reply(text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons)
  });
});

// Принудительный пинг всех СВОИХ сервисов (админ — всех)
bot.action('ping_now', async (ctx) => {
  const list = visibleServices(ctx.from.id);
  if (list.length === 0) {
    return ctx.answerCbQuery('У вас нет добавленных сервисов!');
  }
  ctx.answerCbQuery('Запускаю проверку...');

  for (const item of list) {
    await pingService(item.id);
  }

  ctx.reply('✅ Проверка завершена!', getMainMenu());
});

// Запрос ввода URL
bot.action('add_service', (ctx) => {
  userStates.set(ctx.from.id, { step: 'waiting_for_url' });
  ctx.editMessageText(
    '✍️ *Отправьте ссылку (URL) на сервис, который нужно мониторить:*\n\n' +
    'Пример: `https://my-app.onrender.com` или `https://google.com`',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'main_menu')]])
    }
  );
});

// Меню управления конкретным сервисом
bot.action(/^manage_([a-f0-9]+)$/, (ctx) => {
  const id = ctx.match[1];
  const service = services.get(id);

  if (!ownsOrAdmin(service, ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Сервис не найден или это не ваш сервис');
  }

  let text = `⚙️ *Управление сервисом:*\n\n🔗 *URL:* ${service.url}\n📊 *Статус:* ${service.status}\n⏱ *Таймер:* ${service.intervalMinutes} мин.`;
  if (isAdmin(ctx.from.id) && service.ownerId !== ctx.from.id) {
    text += `\n👤 *Владелец:* ${ownerLabel(service)}`;
  }

  const buttons = [
    [Markup.button.callback('⏱ Изменить интервал', `change_time_${id}`)],
    [Markup.button.callback('🗑 Удалить', `delete_${id}`)],
    [Markup.button.callback('🔙 К списку сервисов', 'list_services')]
  ];

  ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
});

// Выбор нового интервала кнопками
bot.action(/^change_time_([a-f0-9]+)$/, (ctx) => {
  const id = ctx.match[1];
  const service = services.get(id);

  if (!ownsOrAdmin(service, ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Сервис не найден или это не ваш сервис');
  }

  const buttons = [
    [
      Markup.button.callback('1 мин', `set_int_${id}_1`),
      Markup.button.callback('5 мин', `set_int_${id}_5`),
      Markup.button.callback('10 мин', `set_int_${id}_10`),
      Markup.button.callback('15 мин', `set_int_${id}_15`)
    ],
    [Markup.button.callback('🔙 Назад', `manage_${id}`)]
  ];

  ctx.editMessageText(`⏱ Выберите новый интервал проверки для:\n\`${service.url}\``, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Применение нового интервала
bot.action(/^set_int_([a-f0-9]+)_(\d+)$/, (ctx) => {
  const id = ctx.match[1];
  const minutes = parseInt(ctx.match[2], 10);
  const existing = services.get(id);

  if (!ownsOrAdmin(existing, ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Сервис не найден или это не ваш сервис');
  }

  startTimer({
    id,
    url: existing.url,
    minutes,
    chatId: existing.chatId,
    ownerId: existing.ownerId,
    ownerName: existing.ownerName
  });
  ctx.answerCbQuery(`Интервал изменен на ${minutes} мин.`);

  // Возвращаем в меню управления
  const service = services.get(id);
  const text = `⚙️ *Управление сервисом:*\n\n🔗 *URL:* ${service.url}\n📊 *Статус:* ${service.status}\n⏱ *Таймер:* ${service.intervalMinutes} мин.`;
  const buttons = [
    [Markup.button.callback('⏱ Изменить интервал', `change_time_${id}`)],
    [Markup.button.callback('🗑 Удалить', `delete_${id}`)],
    [Markup.button.callback('🔙 К списку сервисов', 'list_services')]
  ];

  ctx.editMessageText(`✅ Интервал успешно изменен на *${minutes} мин.*\n\n` + text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons)
  });
});

// Удаление сервиса
bot.action(/^delete_([a-f0-9]+)$/, (ctx) => {
  const id = ctx.match[1];
  const service = services.get(id);

  if (!ownsOrAdmin(service, ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Сервис не найден или это не ваш сервис');
  }

  const url = service.url;
  stopTimer(id);
  ctx.answerCbQuery('Сервис удален!');

  ctx.editMessageText(`🗑 Сервис \`${url}\` удален из мониторинга.`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 К списку сервисов', 'list_services')]])
  });
});

// Обработка текстовых сообщений (ввод ссылки)
bot.on('text', (ctx) => {
  const state = userStates.get(ctx.from.id);

  if (state && state.step === 'waiting_for_url') {
    let url = ctx.message.text.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      new URL(url);
    } catch (e) {
      return ctx.reply('⚠️ Неверный формат ссылки! Попробуйте еще раз или нажмите Отмена.');
    }

    const id = generateId();

    // Запускаем со стандартным интервалом 5 минут, привязываем к владельцу
    startTimer({
      id,
      url,
      minutes: 5,
      chatId: ctx.chat.id,
      ownerId: ctx.from.id,
      ownerName: ctx.from.username || ''
    });
    userStates.delete(ctx.from.id);

    return ctx.reply(
      `✅ *Сервис успешно добавлен!*\n\n🔗 *URL:* ${url}\n⏱ *Дефолтный интервал:* 5 минут (можно изменить в настройках).\n🔒 Эта ссылка видна только вам.`,
      { parse_mode: 'Markdown', ...getMainMenu() }
    );
  }

  // Если текст отправлен просто так
  ctx.reply('Используйте кнопки меню для управления ботом:', getMainMenu());
});

// --- ЗАПУСК ---

async function main() {
  await storage.init();
  await restoreServices();

  await bot.launch();
  console.log('🤖 Bot successfully started!');
  console.log(`👑 Админ ID: ${ADMIN_ID}`);
}

main().catch((err) => {
  console.error('❌ Ошибка запуска бота:', err);
  process.exit(1);
});

// Грациозное завершение работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
