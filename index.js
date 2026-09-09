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
app.listen(PORT); // без лишних логов — только реальные ошибки идут в консоль

// --- ЭКРАНИРОВАНИЕ ДЛЯ HTML (parse_mode: 'HTML') ---
// В отличие от Markdown, HTML в Telegram не ломается на "_", "*", "[" и т.д.
// Достаточно экранировать всего 3 символа — это надёжно и предсказуемо.
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

// Безопасная отправка/редактирование сообщений — никогда не роняет процесс
async function safeReply(ctx, text, extra) {
  try {
    await ctx.reply(text, extra);
  } catch (err) {
    console.error('⚠️ Ошибка отправки сообщения:', err.message);
  }
}

async function safeEdit(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    // "message is not modified" — не ошибка по сути, просто игнорируем
    if (!/message is not modified/i.test(err.message)) {
      console.error('⚠️ Ошибка редактирования сообщения:', err.message);
    }
    // Если не смогли отредактировать (например, сообщение слишком старое) — отправим новое
    if (!/message is not modified/i.test(err.message)) {
      try { await ctx.reply(text, extra); } catch (e2) { console.error('⚠️ Ошибка отправки сообщения:', e2.message); }
    }
  }
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
      `🚨 <b>СЕРВИС НЕ ОТВЕЧАЕТ!</b>\n\n🔗 <b>URL:</b> ${esc(service.url)}\n❌ <b>Ошибка:</b> ${esc(statusCode)} / ${esc(err.message)}\n⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU')}`,
      { parse_mode: 'HTML' }
    ).catch((e) => console.error('⚠️ Не удалось отправить алерт:', e.message));
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

  // Запускаем первый пинг сразу (в фоне, не блокируя ответ пользователю)
  pingService(id).catch((err) => console.error('⚠️ Ошибка первого пинга:', err.message));

  // Интервал в миллисекундах
  service.timerId = setInterval(() => {
    pingService(id).catch((err) => console.error('⚠️ Ошибка пинга:', err.message));
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
    ? '👑 <b>Все сервисы всех пользователей:</b>\n\n'
    : '📋 <b>Ваши отслеживаемые сервисы:</b>\n\n';

  const buttons = [];

  list.forEach((val) => {
    let domain = val.url;
    try { domain = new URL(val.url).hostname; } catch (e) {}

    messageText += `${esc(val.status)}\n🔗 ${esc(val.url)}\n⏱ Интервал: <b>${val.intervalMinutes} мин.</b> | Проверка: <b>${esc(val.lastCheck)}</b>`;
    if (admin) {
      messageText += `\n👤 Владелец: ${esc(ownerLabel(val))}`;
    }
    messageText += '\n\n';

    const label = admin ? `⚙️ ${domain} (${ownerLabel(val)})` : `⚙️ ${domain}`;
    buttons.push([Markup.button.callback(label, `manage_${val.id}`)]);
  });

  buttons.push([Markup.button.callback('🔙 Назад в меню', 'main_menu')]);

  return { text: messageText, buttons };
}

// --- ОБРАБОТЧИКИ КОМАНД И КНОПОК ---

bot.start(async (ctx) => {
  await safeReply(ctx,
    `👋 <b>Привет! Я бот-пингер для Render и любых сайтов.</b>\n\n` +
    `Я могу регулярно проверять доступность ваших веб-сервисов и присылать предупреждения, если сервис упадет.\n\n` +
    `🔒 Все добавленные ссылки видны только вам — другие пользователи бота их не видят.`,
    { parse_mode: 'HTML', ...getMainMenu() }
  );
});

// Главное меню
bot.action('main_menu', async (ctx) => {
  userStates.delete(ctx.from.id);
  await safeEdit(ctx, '🛠 <b>Главное меню:</b>', { parse_mode: 'HTML', ...getMainMenu() });
});

// Информация
bot.action('help_info', async (ctx) => {
  await safeEdit(ctx,
    `ℹ️ <b>Информация</b>\n\n` +
    `• Добавляйте ссылки на Render, Vercel, VPS или обычные сайты.\n` +
    `• Указывайте дефолтный таймер (например 5-10 мин) или свой кастомный.\n` +
    `• Если сервис выдаст ошибку или перестанет отвечать, бот пришлет алерт.\n` +
    `• 🔒 Ваши сервисы видны только вам — у каждого пользователя своя личная граница.\n\n` +
    `💡 <b>Чтобы бот на Render не засыпал</b>, зарегистрируйте URL созданного бота в бесплатных сервисах вроде UptimeRobot (каждые 10 мин).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'main_menu')]])
    }
  );
});

// Список сервисов (кнопкой)
bot.action('list_services', async (ctx) => {
  const { text, buttons } = buildServicesView(ctx.from.id);
  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons)
  });
});

// Список сервисов (текстовой командой "мои сервисы")
bot.hears(/мои\s*сервис/i, async (ctx) => {
  const { text, buttons } = buildServicesView(ctx.from.id);
  await safeReply(ctx, text, {
    parse_mode: 'HTML',
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
  await ctx.answerCbQuery('Запускаю проверку...');

  for (const item of list) {
    await pingService(item.id);
  }

  await safeReply(ctx, '✅ Проверка завершена!', getMainMenu());
});

// Запрос ввода URL
bot.action('add_service', async (ctx) => {
  userStates.set(ctx.from.id, { step: 'waiting_for_url' });
  await safeEdit(ctx,
    '✍️ <b>Отправьте ссылку (URL) на сервис, который нужно мониторить:</b>\n\n' +
    'Пример: <code>https://my-app.onrender.com</code> или <code>https://google.com</code>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'main_menu')]])
    }
  );
});

// Меню управления конкретным сервисом
bot.action(/^manage_([a-f0-9]+)$/, async (ctx) => {
  const id = ctx.match[1];
  const service = services.get(id);

  if (!ownsOrAdmin(service, ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Сервис не найден или это не ваш сервис');
  }

  let text = `⚙️ <b>Управление сервисом:</b>\n\n🔗 <b>URL:</b> ${esc(service.url)}\n📊 <b>Статус:</b> ${esc(service.status)}\n⏱ <b>Таймер:</b> ${service.intervalMinutes} мин.`;
  if (isAdmin(ctx.from.id) && service.ownerId !== ctx.from.id) {
    text += `\n👤 <b>Владелец:</b> ${esc(ownerLabel(service))}`;
  }

  const buttons = [
    [Markup.button.callback('⏱ Изменить интервал', `change_time_${id}`)],
    [Markup.button.callback('🗑 Удалить', `delete_${id}`)],
    [Markup.button.callback('🔙 К списку сервисов', 'list_services')]
  ];

  await safeEdit(ctx, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
});

// Выбор нового интервала кнопками
bot.action(/^change_time_([a-f0-9]+)$/, async (ctx) => {
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

  await safeEdit(ctx, `⏱ Выберите новый интервал проверки для:\n<code>${esc(service.url)}</code>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Применение нового интервала
bot.action(/^set_int_([a-f0-9]+)_(\d+)$/, async (ctx) => {
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
  await ctx.answerCbQuery(`Интервал изменен на ${minutes} мин.`);

  // Возвращаем в меню управления
  const service = services.get(id);
  const text = `⚙️ <b>Управление сервисом:</b>\n\n🔗 <b>URL:</b> ${esc(service.url)}\n📊 <b>Статус:</b> ${esc(service.status)}\n⏱ <b>Таймер:</b> ${service.intervalMinutes} мин.`;
  const buttons = [
    [Markup.button.callback('⏱ Изменить интервал', `change_time_${id}`)],
    [Markup.button.callback('🗑 Удалить', `delete_${id}`)],
    [Markup.button.callback('🔙 К списку сервисов', 'list_services')]
  ];

  await safeEdit(ctx, `✅ Интервал успешно изменен на <b>${minutes} мин.</b>\n\n` + text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(buttons)
  });
});

// Удаление сервиса
bot.action(/^delete_([a-f0-9]+)$/, async (ctx) => {
  const id = ctx.match[1];
  const service = services.get(id);

  if (!ownsOrAdmin(service, ctx.from.id)) {
    return ctx.answerCbQuery('⛔ Сервис не найден или это не ваш сервис');
  }

  const url = service.url;
  stopTimer(id);
  await ctx.answerCbQuery('Сервис удален!');

  await safeEdit(ctx, `🗑 Сервис <code>${esc(url)}</code> удален из мониторинга.`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 К списку сервисов', 'list_services')]])
  });
});

// Обработка текстовых сообщений (ввод ссылки)
bot.on('text', async (ctx) => {
  const state = userStates.get(ctx.from.id);

  if (state && state.step === 'waiting_for_url') {
    let url = ctx.message.text.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      new URL(url);
    } catch (e) {
      return safeReply(ctx, '⚠️ Неверный формат ссылки! Попробуйте еще раз или нажмите Отмена.');
    }

    const id = generateId();

    // Сразу убираем состояние ожидания, чтобы повторное сообщение не создало второй сервис
    userStates.delete(ctx.from.id);

    // Запускаем со стандартным интервалом 5 минут, привязываем к владельцу
    startTimer({
      id,
      url,
      minutes: 5,
      chatId: ctx.chat.id,
      ownerId: ctx.from.id,
      ownerName: ctx.from.username || ''
    });

    return safeReply(ctx,
      `✅ <b>Сервис успешно добавлен!</b>\n\n🔗 <b>URL:</b> ${esc(url)}\n⏱ <b>Дефолтный интервал:</b> 5 минут (можно изменить в настройках).\n🔒 Эта ссылка видна только вам.`,
      { parse_mode: 'HTML', ...getMainMenu() }
    );
  }

  // Если текст отправлен просто так
  await safeReply(ctx, 'Используйте кнопки меню для управления ботом:', getMainMenu());
});

// Глобальный перехватчик ошибок — бот не падает даже при неожиданной ошибке в хендлере
bot.catch((err, ctx) => {
  console.error(`⚠️ Ошибка в обработчике [${ctx.updateType}]:`, err.message);
});

// Страховка на случай необработанных ошибок за пределами Telegraf — процесс не завершается
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err.message);
});

// --- ЗАПУСК ---

async function main() {
  await storage.init();
  await restoreServices();
  await bot.launch();
}

main().catch((err) => {
  console.error('❌ Ошибка запуска бота:', err.message);
  process.exit(1);
});

// Грациозное завершение работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
