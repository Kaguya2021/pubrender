require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Изолированное хранилище в памяти: userId -> Array of { url, name, status, lastChecked }
const userServices = new Map();

// Функция для нормализации и валидации URL
function parseUrl(input) {
  let urlStr = input.trim();
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = 'http://' + urlStr;
  }
  try {
    const parsed = new URL(urlStr);
    return parsed.href;
  } catch (e) {
    return null;
  }
}

// Функция проверки статуса (Пинг)
async function checkService(url) {
  const start = Date.now();
  try {
    const response = await axios.get(url, { timeout: 5000 });
    const duration = Date.now() - start;
    return {
      status: 'online',
      statusCode: response.status,
      responseTime: duration
    };
  } catch (error) {
    const duration = Date.now() - start;
    return {
      status: 'offline',
      statusCode: error.response ? error.response.status : 'ERR',
      responseTime: duration
    };
  }
}

// Главное меню
function getMainMenu() {
  return Markup.keyboard([
    ['➕ Добавить сервис', '📋 Мои сервисы'],
    ['🔄 Проверить все', 'ℹ️ Помощь']
  ]).resize();
}

// Старт / Меню
bot.start((ctx) => {
  ctx.reply(
    `👋 Привет, ${ctx.from.first_name}!\n\n` +
    `Этот бот позволяет вам мониторить доступность ваших веб-сервисов и сайтов.\n` +
    `Все добавленные сервисы будут видны **только вам**!`,
    getMainMenu()
  );
});

bot.hears('ℹ️ Помощь', (ctx) => {
  ctx.reply(
    `📌 **Как пользоваться ботом:**\n\n` +
    `1. Нажмите **➕ Добавить сервис** и отправьте ссылку на ваш сайт или API.\n` +
    `2. В разделе **📋 Мои сервисы** вы можете просматривать только персонально ваши ссылки и удалять их.\n` +
    `3. Нажмите **🔄 Проверить все**, чтобы запустить пинг всех ваших сервисов.`,
    { parse_mode: 'Markdown' }
  );
});

// Добавление сервиса
bot.hears('➕ Добавить сервис', (ctx) => {
  ctx.reply('Отправьте ссылку на сайт или сервис (например: `https://my-app.onrender.com` или `mysite.com`):', {
    parse_mode: 'Markdown'
  });
});

// Мои сервисы (изолировано по userId)
bot.hears('📋 Мои сервисы', async (ctx) => {
  const userId = ctx.from.id;
  const services = userServices.get(userId) || [];

  if (services.length === 0) {
    return ctx.reply('У вас пока нет добавленных сервисов.', getMainMenu());
  }

  let text = `📋 **Ваши сервисы (${services.length}):**\n\n`;
  const buttons = [];

  services.forEach((service, index) => {
    const statusIcon = service.status === 'online' ? '🟢' : service.status === 'offline' ? '🔴' : '⚪';
    text += `${index + 1}. ${statusIcon} **${service.name}**\n🔗 \`${service.url}\`\n\n`;
    buttons.push([Markup.button.callback(`❌ Удалить: ${service.name}`, `del_${index}`)]);
  });

  ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Проверить все сервисы (Пинг)
bot.hears('🔄 Проверить все', async (ctx) => {
  const userId = ctx.from.id;
  const services = userServices.get(userId) || [];

  if (services.length === 0) {
    return ctx.reply('У вас нет сервисов для проверки. Сначала добавьте их через «➕ Добавить сервис».');
  }

  const waitMsg = await ctx.reply('🔄 Выполняется пинг ваших сервисов...');

  let resultText = `📊 **Результаты проверки:**\n\n`;

  for (let i = 0; i < services.length; i++) {
    const service = services[i];
    const res = await checkService(service.url);
    
    service.status = res.status;
    service.lastChecked = new Date().toLocaleTimeString();

    const icon = res.status === 'online' ? '🟢' : '🔴';
    resultText += `${icon} **${service.name}**\n` +
                  `• Статус: ${res.status.toUpperCase()} (${res.statusCode})\n` +
                  `• Пинг: ${res.responseTime}ms\n\n`;
  }

  ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
  ctx.reply(resultText, { parse_mode: 'Markdown', ...getMainMenu() });
});

// Обработка текстовых сообщений (добавление ссылок)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  // Игнорируем команды меню
  if (['➕ Добавить сервис', '📋 Мои сервисы', '🔄 Проверить все', 'ℹ️ Помощь'].includes(text)) {
    return;
  }

  const validUrl = parseUrl(text);
  if (!validUrl) {
    return ctx.reply('❌ Неверный формат URL. Попробуйте отправить ссылку заново (например, `example.com` или `https://api.site.com`).', {
      parse_mode: 'Markdown'
    });
  }

  if (!userServices.has(userId)) {
    userServices.set(userId, []);
  }

  const userList = userServices.get(userId);

  // Проверка на дубликат у конкретного пользователя
  if (userList.some(s => s.url === validUrl)) {
    return ctx.reply('⚠️ Этот сервис уже есть в вашем списке!');
  }

  let domainName = '';
  try {
    domainName = new URL(validUrl).hostname;
  } catch (e) {
    domainName = validUrl;
  }

  const newService = {
    url: validUrl,
    name: domainName,
    status: 'unknown',
    lastChecked: null
  };

  userList.push(newService);

  ctx.reply(`✅ Сервис **${domainName}** успешно добавлен в ваш личный список!`, {
    parse_mode: 'Markdown',
    ...getMainMenu()
  });
});

// Обработка удаления сервисов (по callback query)
bot.action(/^del_(\d+)$/, (ctx) => {
  const userId = ctx.from.id;
  const index = parseInt(ctx.match[1], 10);
  const userList = userServices.get(userId) || [];

  if (index >= 0 && index < userList.length) {
    const removed = userList.splice(index, 1)[0];
    ctx.answerCbQuery(`Удалено: ${removed.name}`);
    
    if (userList.length === 0) {
      return ctx.editMessageText('Ваш список сервисов пуст.');
    }

    let text = `📋 **Ваши сервисы (${userList.length}):**\n\n`;
    const buttons = [];

    userList.forEach((service, idx) => {
      const statusIcon = service.status === 'online' ? '🟢' : service.status === 'offline' ? '🔴' : '⚪';
      text += `${idx + 1}. ${statusIcon} **${service.name}**\n🔗 \`${service.url}\`\n\n`;
      buttons.push([Markup.button.callback(`❌ Удалить: ${service.name}`, `del_${idx}`)]);
    });

    ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  } else {
    ctx.answerCbQuery('Ошибка: сервис не найден.');
  }
});

// Запуск бота
bot.launch().then(() => {
  console.log('🚀 Pingo Bot успешно запущен!');
});

// Чтобы Render сразу увидел открытый порт (если это Web Service):
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
});

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
