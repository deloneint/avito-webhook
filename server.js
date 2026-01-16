const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

// ==========================================
// КОНФИГУРАЦИЯ
// ==========================================
const PORT = process.env.PORT || 3000;
const AVITO_CLIENT_ID = "V4rdxQkY1T_irD-e9XUM";
const AVITO_CLIENT_SECRET = "KvfhnCzGlpaLIX05VOYkzJbQCGOtgEWtB3y2iZxj"; 
// Обнови токен, если он изменился
const REFRESH_TOKEN = "hB-b5Ly2RbmZ44mAUGn7DASUOb9s-f9siGnroraOQYxxYdaMw8LA4mbEdESjHWY5IDOnJ6kqHH7Gi4n7fxATdeE5V76STsRKoLlVP_CcT2iMRbGMqgXEp_T9aI84Eol4"; 

// Секретный ключ. ДОЛЖЕН ТОЧНО СОВПАДАТЬ С ТОКОМ, ЧТО БЫЛ В ЛОГЕ ВКЛЮЧЕНИЯ ВЕБХУКА!
const WEBHOOK_SECRET = "my_super_secret_1102"; 

const { GoogleSpreadsheet } = require('google-spreadsheet');
// Считываем креды из переменной окружения Render (настроим ниже)
const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");
const SPREADSHEET_ID = "1SI5MxQ_-NcDRSjZvIKYEcAVgcnT2tTJxYujT33BmQOw"; 

// ==========================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ==========================================
let accessToken = "";
let vacanciesCache = {}; 
let processedIdsCache = new Set(); // Кэш ID, чтобы не писать дубликаты

const app = express();
app.use(bodyParser.json());

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

async function refreshAccessToken() {
    try {
        const response = await axios.post('https://api.avito.ru/token/', new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: AVITO_CLIENT_ID,
            client_secret: AVITO_CLIENT_SECRET,
            refresh_token: REFRESH_TOKEN
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        accessToken = response.data.access_token;
        console.log("🔄 Access Token обновлен");
    } catch (error) {
        console.error("❌ Ошибка обновления токена:", error.response ? error.response.data : error.message);
    }
}
// ==========================================
// ПОЛУЧЕНИЕ ДАННЫХ ВАКАНСИИ (ФИНАЛЬНАЯ ВЕРСИЯ)
// ==========================================
async function getVacancyDetails(vacancyId) {
    // Проверяем кэш
    if (vacanciesCache[vacancyId]) {
        return vacanciesCache[vacancyId];
    }

    try {
        // Используем job/v2/vacancies/{id}
        const response = await axios.get(`https://api.avito.ru/job/v2/vacancies/${vacancyId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.data) {
            const vac = response.data;
            
            // ИСПРАВЛЕНИЕ: Используем title для названия
            // ИСПРАВЛЕНИЕ: Используем addressDetails.address для адреса
            const vacInfo = {
                name: vac.title || `ID: ${vacancyId}`,
                address: vac.addressDetails?.address || "Адрес не указан"
            };
            
            vacanciesCache[vacancyId] = vacInfo;
            console.log(`✅ Вакансия загружена: ${vacInfo.name} (${vacInfo.address})`);
            return vacInfo;
        }
    } catch (error) {
        console.log(`⚠️ Не удалось загрузить детали вакансии ${vacancyId}. Статус:`, error.response?.status);
        return { name: `ID: ${vacancyId}`, address: "Не найден" };
    }
}

async function loadVacancies() {
    try {
        const response = await axios.get('https://api.avito.ru/items/v1/items', {
            params: { category: 111 }, 
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.data && response.data.resources) {
            response.data.resources.forEach(vac => {
                vacanciesCache[vac.id] = vac.name;
            });
            console.log(`✅ Кэш вакансий обновлен: ${response.data.resources.length} шт.`);
        }
    } catch (error) {
        console.log("⚠️ Не удалось загрузить список вакансий (будут видны ID).");
        // Если items/v1 не работает, можно попробовать job/v1/vacancies
    }
}

// ==========================================
// ОТПРАВКА В GOOGLE SHEETS
// ==========================================
async function sendToSheet(data) {
    const doc = await new GoogleSpreadsheet(SPREADSHEET_ID);
    
    await doc.useServiceAccountAuth({
        client_email: creds.client_email,
        private_key: creds.private_key,
    });

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Используем формулу HYPERLINK (разделитель ";", так как таблица русская)
    // Ссылка будет текстом "Открыть чат", а при клике откроется диалог
    const linkFormula = `=HYPERLINK("${data.chat_link}"; "Открыть чат")`;

    const row = [
        new Date().toLocaleString('ru-RU'),
        data.vacancy_name,       // Название вакансии
        data.vacancy_address,     // Адрес вакансии
        data.applicant_name,      // Имя
        data.phone,              // Телефон
        linkFormula,            // Ссылка на чат (как кнопка)
        data.status              // Статус
    ];
    
    await sheet.addRow(row);
    console.log("📝 Строка добавлена в таблицу:", data.vacancy_name);
}
// ==========================================
// ПОЛУЧЕНИЕ ДЕТАЛЕЙ ОТКЛИКА (С КРАСИВОЙ ССЫЛКОЙ)
// ==========================================
async function getApplicationDetails(applyId) {
    try {
        const response = await axios.post('https://api.avito.ru/job/v1/applications/get_by_ids', {
            ids: [applyId]
        }, {
            headers: { 
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.data && response.data.applies && response.data.applies.length > 0) {
            const appData = response.data.applies[0];
            
            // 1. Получаем данные вакансии
            let vacName = `ID: ${appData.vacancy_id}`;
            let vacAddress = "Неизвестно";

            try {
                const vacInfo = await getVacancyDetails(appData.vacancy_id);
                if (vacInfo) {
                    vacName = vacInfo.name;
                    vacAddress = vacInfo.address;
                }
            } catch (e) {
                console.log(`⚠️ Детали вакансии ${appData.vacancy_id} недоступны.`);
            }

            // 2. Формируем КРАСИВУЮ ссылку на чат
            let chatLink = "";
            if (appData.contacts && appData.contacts.chat && appData.contacts.chat.value) {
                chatLink = `https://www.avito.ru/profile/messenger/channel/${appData.contacts.chat.value}`;
            }

            // 3. Формируем телефон
            let phoneString = "Не указан";
            if (appData.contacts.phones && appData.contacts.phones.length > 0) {
                phoneString = appData.contacts.phones.map(p => p.value).join(", ");
            }

            console.log(`✅ Данные: ${appData.applicant.data.name} -> ${vacName}`);

            return {
                vacancy_name: vacName,
                vacancy_address: vacAddress,
                chat_link: chatLink, // Теперь красивая ссылка
                applicant_name: appData.applicant.data.name,
                phone: phoneString,
                status: appData.is_viewed ? "Просмотрен" : "Новый",
                applyId: appData.id
            };
        }
    } catch (error) {
        console.error("Ошибка получения деталей отклика:", error.response ? error.response.data : error.message);
    }
    return null;
}

// ==========================================
// ENDPOINT WEBHOOK
// ==========================================
app.post('/webhook', async (req, res) => {
    console.log("🔔 Пришел Webhook");
    
    // 1. Проверка X-Secret
    const receivedSecret = req.headers['x-secret'];
    if (receivedSecret !== WEBHOOK_SECRET) {
        console.log("⚠️ Неверный секрет!");
        console.log("Ожидалось:", WEBHOOK_SECRET);
        console.log("Получено:", receivedSecret);
        return res.status(403).send('Forbidden');
    }

    // 2. Ping-запрос
    if (!req.body || Object.keys(req.body).length === 0) {
        console.log("🏓 Ping-запрос");
        return res.status(200).send('OK');
    }

    // 3. Обработка
    const applyId = req.body.applyId;
    
    if (!applyId) {
        console.log("⚠️ Нет applyId");
        return res.status(200).send('OK');
    }

    // ИСПРАВЛЕНИЕ: Проверка на дубликаты
    if (processedIdsCache.has(applyId)) {
        console.log(`⏩ Отклик ${applyId} уже обрабатывался. Пропускаем.`);
        return res.status(200).send('OK');
    }
    
    console.log(`🆕 Новый отклик ID: ${applyId}`);

    const details = await getApplicationDetails(applyId);
    
    if (details) {
        await sendToSheet(details);
        // Запоминаем ID, чтобы не записать снова
        processedIdsCache.add(applyId);
    }

    res.status(200).send('OK');
});

// ==========================================
// ЗАПУСК
// ==========================================
(async () => {
    await refreshAccessToken();
    await loadVacancies();
    
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
        console.log(`Webhook URL: https://tushed-rosette-imbalancedly.ngrok-free.dev/webhook`);
    });

    // Обновление раз в час
    setInterval(refreshAccessToken, 60 * 60 * 1000);
    setInterval(loadVacancies, 60 * 60 * 1000);
})();
