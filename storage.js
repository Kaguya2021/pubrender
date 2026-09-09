const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'services.json');

let useMongo = false;
let ServiceModel = null;

// В памяти всегда держим актуальный список (нужно для файлового режима)
let fileCache = [];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readFileSafe() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error('⚠️ Не удалось прочитать файл данных, начинаю с пустого списка:', err.message);
    return [];
  }
}

function writeFileSafe(arr) {
  try {
    ensureDataDir();
    // Пишем во временный файл и переименовываем — так меньше риск повредить данные при сбое
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('⚠️ Не удалось сохранить файл данных:', err.message);
  }
}

async function init() {
  if (process.env.MONGODB_URI) {
    try {
      const mongoose = require('mongoose');
      await mongoose.connect(process.env.MONGODB_URI);

      const schema = new mongoose.Schema({
        id: { type: String, unique: true, required: true, index: true },
        ownerId: { type: Number, required: true },
        ownerName: { type: String, default: '' },
        chatId: { type: Number, required: true },
        url: { type: String, required: true },
        intervalMinutes: { type: Number, required: true },
        status: { type: String, default: '' },
        lastCheck: { type: String, default: '' }
      });

      ServiceModel = mongoose.models.Service || mongoose.model('Service', schema);
      useMongo = true;
      console.log('🗄 Подключено к MongoDB — данные сервисов хранятся в базе.');
    } catch (err) {
      console.error('⚠️ Не удалось подключиться к MongoDB, перехожу на локальный файл:', err.message);
      useMongo = false;
    }
  }

  if (!useMongo) {
    ensureDataDir();
    fileCache = readFileSafe();
    console.log(`💾 Использую локальное файловое хранилище: ${DATA_FILE}`);
  }
}

async function getAll() {
  if (useMongo) {
    const docs = await ServiceModel.find({}).lean();
    return docs.map((d) => ({
      id: d.id,
      ownerId: d.ownerId,
      ownerName: d.ownerName || '',
      chatId: d.chatId,
      url: d.url,
      intervalMinutes: d.intervalMinutes,
      status: d.status,
      lastCheck: d.lastCheck
    }));
  }
  return fileCache;
}

async function upsert(record) {
  if (useMongo) {
    await ServiceModel.findOneAndUpdate({ id: record.id }, record, {
      upsert: true,
      setDefaultsOnInsert: true
    });
    return;
  }
  const idx = fileCache.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    fileCache[idx] = record;
  } else {
    fileCache.push(record);
  }
  writeFileSafe(fileCache);
}

async function remove(id) {
  if (useMongo) {
    await ServiceModel.deleteOne({ id });
    return;
  }
  fileCache = fileCache.filter((r) => r.id !== id);
  writeFileSafe(fileCache);
}

module.exports = { init, getAll, upsert, remove };
