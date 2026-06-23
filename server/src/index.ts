import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import clientsRouter from './routes/clients.js';
import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import appointmentsRouter from './routes/appointments.js';
import statsRouter from './routes/stats.js';
import { checkSupabaseConnection } from './lib/supabase.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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