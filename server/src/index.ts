import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

console.log("CURRENT DIR =", process.cwd());
console.log("OPENROUTER =", process.env.OPENROUTER_API_KEY);

import express from 'express';
import cors from 'cors';
import clientsRouter from './routes/clients.js';
import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import appointmentsRouter from './routes/appointments.js';
import statsRouter from './routes/stats.js';
import { checkSupabaseConnection } from './lib/supabase.js';

const app = express();

const chatHistory = new Map<number, any[]>();

const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
async function generateAIResponse(chatId: number, text: string) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterKey) {
    return 'OpenRouter API key not configured';
  }

  const history = chatHistory.get(chatId) || [];

history.push({
  role: 'user',
  content: text
});
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3001',
      'X-Title': 'AI Salon Admin',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Ты AI-администратор салона красоты.
      
      Твоя задача — записать клиента.
      
      Нужно собрать:
      1. услугу
      2. день
      3. время
      4. имя
      5. телефон
      
      Правила:
      - Не спрашивай то, что клиент уже написал.
      - Спрашивай только один следующий вопрос за раз.
      - Отвечай коротко и дружелюбно.
      - Если все данные собраны, кратко подтверди запись.
      - Пиши только на русском языке.`
        },
        ...history
      ]
    })
  });

  const data = await response.json();

  console.log(JSON.stringify(data, null, 2));

  const answer =
  data.choices?.[0]?.message?.content ||
  'Здравствуйте! Чем могу помочь?';

history.push({
  role: 'assistant',
  content: answer
});

chatHistory.set(chatId, history.slice(-10));

if (
  answer.includes("подтверждена") ||
  answer.includes("подтверждена.") ||
  answer.includes("Ждем вас")
) {
  const adminChatId = process.env.TELEGRAM_CHAT_ID;

  if (adminChatId) {
    await sendTelegramMessage(
      Number(adminChatId),
      `🔔 Новая запись!\n\n${history
        .filter(m => m.role === "user")
        .map(m => "• " + m.content)
        .join("\n")}`
    );
  }
}

return answer;
}

app.get('/api/health', async (_req, res) => {
  const dbConnected = await checkSupabaseConnection();
  res.json({
    status: dbConnected ? 'ok' : 'degraded',
    name: 'AI Salon Admin API',
    database: dbConnected ? 'connected' : 'disconnected',
  });
});
app.get('/api/telegram/status', async (_req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return res.status(400).json({
      connected: false,
      error: 'Telegram token not configured'
    });
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`
    );

    const data = await response.json();

    if (data.ok) {
      return res.json({
        connected: true,
        bot: data.result.username,
        name: data.result.first_name
      });
    }

    return res.json({
      connected: false
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: 'Telegram API error'
    });
  }
});

app.use('/api/clients', clientsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/stats', statsRouter);

app.listen(PORT, () => {
  console.log(`AI Salon Admin API running on http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ?? 'NOT CONFIGURED'}`);
});
async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}
app.get('/api/telegram/test', async (_req, res) => {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!chatId) {
    return res.status(400).json({
      error: 'Chat ID not configured'
    });
  }

  await sendTelegramMessage(
    Number(chatId),
    '🎉 AI Salon Admin подключен к Telegram!'
  );

  res.json({
    success: true
  });
});
let telegramOffset = 0;

async function startTelegramPolling() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('Telegram bot token not configured');
    return;
  }

  console.log('Telegram polling started');

  setInterval(async () => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset + 1}`
      );

      const data = await response.json();

      if (!data.ok) return;

      for (const update of data.result) {
        telegramOffset = update.update_id;

        const message = update.message;
        const text = message?.text;
        const chatId = message?.chat?.id;

        if (!text || !chatId) continue;

        
        const answer = await generateAIResponse(chatId, text);
        await sendTelegramMessage(chatId, answer);

        if (
          answer.toLowerCase().includes('запись') &&
          answer.toLowerCase().includes('подтвержд')
        ) {
          const adminChatId = process.env.TELEGRAM_CHAT_ID;
        
          if (adminChatId && Number(adminChatId) !== chatId) {
            await sendTelegramMessage(
              Number(adminChatId),
              `📌 Новая запись из Telegram:\n\n${answer}\n\nКлиентский chat_id: ${chatId}`
            );
          }
        }
      }
    } catch (error) {
      console.error('Telegram polling error', error);
    }
  }, 3000);
}

startTelegramPolling();