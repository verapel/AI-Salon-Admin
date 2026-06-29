import dotenv from 'dotenv';
import path from 'path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

console.log("CURRENT DIR =", process.cwd());

import express from 'express';
import cors from 'cors';
import clientsRouter from './routes/clients.js';
import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import appointmentsRouter from './routes/appointments.js';
import statsRouter from './routes/stats.js';
import developerRouter from './routes/developer.js';
import { supabase, checkSupabaseConnection } from './lib/supabase.js';

const app = express();

const chatHistory = new Map<number, any[]>();
type BookingStep = 'service' | 'date' | 'time' | 'name' | 'phone';

interface BookingData {
  step?: BookingStep;
  service: string;
  date: string;
  time: string;
  name: string;
  phone: string;
}

const bookingState = new Map<number, BookingData>();

type ManageAction = 'cancel' | 'reschedule';
type ManageStep = 'ask_phone' | 'confirm_appointment' | 'select_new_date' | 'select_new_time';

interface ManageData {
  action: ManageAction;
  step: ManageStep;
  phone?: string;
  clientId?: string;
  appointmentId?: string;
  newDate?: string;
}

const manageState = new Map<number, ManageData>();

const PORT = process.env.PORT || 3001;

// Маппинг русских месяцев (родительный + именительный падеж)
const MONTH_MAP: Record<string, number> = {
  'январь': 1, 'января': 1,
  'февраль': 2, 'февраля': 2,
  'март': 3, 'марта': 3,
  'апрель': 4, 'апреля': 4,
  'май': 5, 'мая': 5,
  'июнь': 6, 'июня': 6,
  'июль': 7, 'июля': 7,
  'август': 8, 'августа': 8,
  'сентябрь': 9, 'сентября': 9,
  'октябрь': 10, 'октября': 10,
  'ноябрь': 11, 'ноября': 11,
  'декабрь': 12, 'декабря': 12,
};

function parseAppointmentDate(input: string): string {
  const trimmed = input.trim();
  console.log(`[parseDate] raw input: "${trimmed}"`);

  // Если уже ISO-формат YYYY-MM-DD (например, из кнопки) — вернуть как есть
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    console.log(`[parseDate] ISO detected, returning: "${trimmed}"`);
    return trimmed;
  }

  const now = new Date();
  const text = trimmed.toLowerCase();

  // "сегодня"
  if (text.includes("сегодня")) {
    // остаётся today
  }
  // "завтра"
  else if (text.includes("завтра")) {
    now.setDate(now.getDate() + 1);
  }
  // "DD месяц" / "DD-го месяц" — например "2 августа", "30 июня", "1 июля"
  else {
    const match = text.match(/(\d{1,2})(?:-?го)?\s+([а-яё]+)/);
    if (match) {
      const day = parseInt(match[1], 10);
      const monthName = match[2];
      const monthNum = MONTH_MAP[monthName];
      if (monthNum) {
        // Используем Date(year, month, day) чтобы избежать переполнения при setMonth
        const year = now.getFullYear();
        const candidate = new Date(year, monthNum - 1, day);
        // Если дата уже прошла — берём следующий год
        if (candidate < now) {
          candidate.setFullYear(year + 1);
        }
        const formatted = `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;
        console.log(`[parseDate] parsed "DD месяц": day=${day}, month=${monthNum}, result=${formatted}`);
        return formatted;
      }
    }
  }

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const result = `${yyyy}-${mm}-${dd}`;
  console.log(`[parseDate] result: "${result}"`);
  return result;
}

// Форматирует дату для пользователя: ISO → "29 июня", всё остальное — как есть
function formatDateForUser(input: string): string {
  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [, m, d] = trimmed.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  }
  return trimmed;
}

// Генерирует inline-кнопки с ближайшими 4 датами + "ввести вручную"
function getDateKeyboard(): { text: string; callback_data: string }[][] {
  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const buttons: { text: string; callback_data: string }[] = [];

  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    buttons.push({ text: label, callback_data: `date:${iso}` });
  }
  buttons.push({ text: '✍️ Ввести дату', callback_data: 'date:manual' });

  // По 2 кнопки в ряд
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  return keyboard;
}

// Форматирует запись для отображения клиенту
function formatAppointmentForUser(appt: any): string {
  const date = formatDateForUser((appt.date as string) ?? '');
  const time = appt.start_time ? (appt.start_time as string).slice(0, 5) : '?';
  const notes = (appt.notes as string) ?? '';
  // Новый формат: "Услуга: Стрижка\n..."
  // Старый формат (обратная совместимость): "Telegram: Стрижка, ..."
  const serviceNew = notes.match(/Услуга: (.+)/m)?.[1]?.trim();
  const serviceOld = notes.match(/Telegram: (.+?),/)?.[1];
  const service = serviceNew ?? serviceOld ?? 'услуга';
  return `📅 ${date} в ${time} — ${service}`;
}

// Клавиатура выбора даты при переносе (с appointmentId в callback_data)
function getRescheduleDateKeyboard(appointmentId: string): { text: string; callback_data: string }[][] {
  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const buttons: { text: string; callback_data: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    buttons.push({ text: label, callback_data: `rdate:${appointmentId}:${iso}` });
  }
  buttons.push({ text: '✍️ Ввести дату', callback_data: `rdate_manual:${appointmentId}` });
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  return keyboard;
}

function parseAppointmentTime(input: string): string {
  const match = input.match(/(\d{1,2})[:. ]?(\d{2})?/);
  if (!match) return "10:00";

  const hours = match[1].padStart(2, "0");
  const minutes = match[2] || "00";

  return `${hours}:${minutes}`;
}

function addOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const nextHour = String((h + 1) % 24).padStart(2, "0");
  const minutes = String(m).padStart(2, "0");

  return `${nextHour}:${minutes}`;
}

app.use(cors());
app.use(express.json());
async function generateAIResponse(chatId: number, text: string): Promise<string | null> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterKey) {
    return 'OpenRouter API key not configured';
  }

  const history = [...(chatHistory.get(chatId) || [])];

  history.push({
    role: 'user',
    content: text
  });

  // --- 0. Определяем intent: отмена / перенос ---
  const lowerText = text.toLowerCase().trim();
  if (!manageState.has(chatId)) {
    const isCancelIntent = /отмен|cancel/.test(lowerText);
    const isRescheduleIntent = /перенос|перенес|перенести/.test(lowerText);
    if (isCancelIntent || isRescheduleIntent) {
      bookingState.delete(chatId);
      const action: ManageAction = isCancelIntent ? 'cancel' : 'reschedule';
      manageState.set(chatId, { action, step: 'ask_phone' });
      const msg = action === 'cancel'
        ? 'Конечно, помогу отменить запись. Введите номер телефона, по которому вы записаны.'
        : 'Конечно, помогу перенести запись. Введите номер телефона, по которому вы записаны.';
      history.push({ role: 'assistant', content: msg });
      chatHistory.set(chatId, history.slice(-10));
      return msg;
    }
  }

  // --- 1. Обработка шагов manage (отмена / перенос) ---
  const manage = manageState.get(chatId);
  if (manage) {
    if (manage.step === 'ask_phone') {
      const phone = text;
      const { data: client } = await (supabase as any)
        .from('clients').select('id').eq('phone', phone).maybeSingle();
      if (!client) {
        manageState.delete(chatId);
        const msg = 'Не нашла запись с таким номером. Если хотите записаться, напишите название услуги.';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(chatId, history.slice(-10));
        return msg;
      }
      const today = new Date().toISOString().split('T')[0];
      const { data: appointments } = await (supabase as any)
        .from('appointments')
        .select('id, date, start_time, notes')
        .eq('client_id', client.id)
        .gte('date', today)
        .order('date', { ascending: true });
      if (!appointments || appointments.length === 0) {
        manageState.delete(chatId);
        const msg = 'Будущих записей не найдено. Если хотите записаться, напишите название услуги.';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(chatId, history.slice(-10));
        return msg;
      }
      manageState.set(chatId, { ...manage, step: 'confirm_appointment', phone, clientId: client.id });
      if (appointments.length === 1) {
        const appt = appointments[0];
        const apptText = formatAppointmentForUser(appt);
        if (manage.action === 'cancel') {
          const msg = `Ваша запись:\n${apptText}\n\nОтменить её?`;
          const keyboard = [[
            { text: '✅ Да, отменить', callback_data: `cancel_confirm:${appt.id}` },
            { text: '❌ Нет, оставить', callback_data: 'cancel_keep' }
          ]];
          history.push({ role: 'assistant', content: msg });
          chatHistory.set(chatId, history.slice(-10));
          await sendTelegramMessageWithKeyboard(chatId, msg, keyboard);
          return null;
        } else {
          manageState.set(chatId, { ...manage, step: 'select_new_date', phone, clientId: client.id, appointmentId: appt.id });
          const msg = `Ваша запись:\n${apptText}\n\nВыберите новую дату:`;
          history.push({ role: 'assistant', content: msg });
          chatHistory.set(chatId, history.slice(-10));
          await sendTelegramMessageWithKeyboard(chatId, msg, getRescheduleDateKeyboard(appt.id));
          return null;
        }
      } else {
        const keyboard = (appointments as any[]).map(a => [{
          text: formatAppointmentForUser(a),
          callback_data: manage.action === 'cancel' ? `select_cancel:${a.id}` : `select_reschedule:${a.id}`
        }]);
        const msg = manage.action === 'cancel' ? 'Какую запись вы хотите отменить?' : 'Какую запись вы хотите перенести?';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(chatId, history.slice(-10));
        await sendTelegramMessageWithKeyboard(chatId, msg, keyboard);
        return null;
      }
    }

    if (manage.step === 'select_new_date') {
      // Пользователь ввёл дату вручную при переносе
      const parsedDate = parseAppointmentDate(text);
      manageState.set(chatId, { ...manage, newDate: parsedDate });
      // Исключаем саму переносимую запись, чтобы её слот не блокировался
      const freeSlots = await getAvailableSlots(parsedDate, manage.appointmentId);
      if (freeSlots.length === 0) {
        const msg = 'На эту дату нет свободного времени. Выберите другой день:';
        history.push({ role: 'assistant', content: msg });
        chatHistory.set(chatId, history.slice(-10));
        await sendTelegramMessageWithKeyboard(chatId, msg, getRescheduleDateKeyboard(manage.appointmentId!));
        return null;
      }
      const keyboard: { text: string; callback_data: string }[][] = [];
      for (let i = 0; i < freeSlots.length; i += 3) {
        keyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `rtime:${manage.appointmentId}:${s}` })));
      }
      const msg = 'Выберите удобное время:';
      history.push({ role: 'assistant', content: msg });
      chatHistory.set(chatId, history.slice(-10));
      await sendTelegramMessageWithKeyboard(chatId, msg, keyboard);
      return null;
    }

    // Другие шаги manage — ждём кнопок
    return 'Пожалуйста, используйте кнопки для выбора.';
  }

  // --- Шаг-машина: обработка шага ДО вызова OpenRouter ---
  const currentState = bookingState.get(chatId);

  if (currentState?.step) {
    if (currentState.step === 'service') {
      bookingState.set(chatId, { ...currentState, step: 'date', service: text });

    } else if (currentState.step === 'date') {
      console.log(`[step:date] raw text: "${text}" | bookingState before:`, JSON.stringify(currentState));
      bookingState.set(chatId, { ...currentState, step: 'time', date: text });
      console.log(`[step:date] bookingState after:`, JSON.stringify(bookingState.get(chatId)));

    } else if (currentState.step === 'time') {
      // Проверяем слот СРАЗУ — до того как AI спросит имя
      console.log(`[step:time] raw text: "${text}" | currentState.date: "${currentState.date}"`);
      const appointmentDate = parseAppointmentDate(currentState.date);
      const appointmentTime = parseAppointmentTime(text);
      console.log(`[step:time] appointmentDate: "${appointmentDate}" | appointmentTime: "${appointmentTime}"`);

      const { data: existingSlot } = await (supabase as any)
        .from('appointments')
        .select('id')
        .eq('date', appointmentDate)
        .eq('start_time', `${appointmentTime}:00`)
        .limit(1)
        .maybeSingle();

      if (existingSlot) {
        const freeSlots = await getAvailableSlots(appointmentDate);

        if (freeSlots.length === 0) {
          // На эту дату нет ни одного свободного слота — просим выбрать другой день
          bookingState.set(chatId, { ...currentState, step: 'date', time: '' });
          const noSlotsMsg = `На эту дату свободного времени нет. Пожалуйста, выберите другой день.`;
          history.push({ role: 'assistant', content: noSlotsMsg });
          chatHistory.set(chatId, history.slice(-10));
          return noSlotsMsg;
        }

        // Собираем inline-кнопки: по 3 слота в ряд
        const keyboard: { text: string; callback_data: string }[][] = [];
        for (let i = 0; i < freeSlots.length; i += 3) {
          keyboard.push(
            freeSlots.slice(i, i + 3).map(slot => ({ text: slot, callback_data: `time:${slot}` }))
          );
        }

        const busyMsg = `К сожалению, это время уже занято. Доступное время на ${currentState.date}:`;
        history.push({ role: 'assistant', content: busyMsg });
        chatHistory.set(chatId, history.slice(-10));

        // Отправляем с кнопками — polling не должен отправлять ещё раз
        await sendTelegramMessageWithKeyboard(chatId, busyMsg, keyboard);
        return null;
      }

      // Слот свободен — сохраняем время, сразу спрашиваем имя (без OpenRouter)
      bookingState.set(chatId, { ...currentState, step: 'name', time: text });
      const nameQuestion = "Отлично, записываю. Подскажите, как вас зовут?";
      history.push({ role: 'assistant', content: nameQuestion });
      chatHistory.set(chatId, history.slice(-10));
      return nameQuestion;

    } else if (currentState.step === 'name') {
      // Сохраняем имя, сразу спрашиваем телефон (без OpenRouter)
      bookingState.set(chatId, { ...currentState, step: 'phone', name: text });
      const phoneQuestion = "И оставьте, пожалуйста, номер телефона для связи.";
      history.push({ role: 'assistant', content: phoneQuestion });
      chatHistory.set(chatId, history.slice(-10));
      return phoneQuestion;

    } else if (currentState.step === 'phone') {
      const finalState = { ...currentState, phone: text };
      bookingState.set(chatId, finalState);

      const { service, date, time, name, phone } = finalState;

      // 1. Сразу говорим клиенту что обрабатываем
      await sendTelegramMessage(chatId, "Секунду, проверяю и записываю вас... 🗓");

      // 2. Найти или создать клиента
      const { data: existingClient, error: lookupError } = await (supabase as any)
        .from("clients").select("id").eq("phone", phone).maybeSingle();

      if (lookupError) {
        console.error("Client lookup error:", lookupError);
        bookingState.delete(chatId); chatHistory.delete(chatId);
        return "Произошла ошибка при поиске клиента. Попробуйте ещё раз.";
      }

      let clientId: string;
      if (existingClient) {
        clientId = existingClient.id;
      } else {
        const { data: newClient, error: insertClientError } = await (supabase as any)
          .from("clients").insert({ name, phone, email: "" }).select("id").single();
        if (insertClientError || !newClient) {
          console.error("Client insert error:", insertClientError);
          bookingState.delete(chatId); chatHistory.delete(chatId);
          return "Не удалось сохранить данные клиента. Попробуйте ещё раз.";
        }
        clientId = newClient.id;
      }

      // 3. Получить услугу
      const { data: serviceRow, error: serviceError } = await (supabase as any)
        .from("services").select("id").limit(1).single();
      if (serviceError || !serviceRow) {
        console.error("Service lookup error:", serviceError);
        bookingState.delete(chatId); chatHistory.delete(chatId);
        return "Не удалось найти услугу. Обратитесь к администратору.";
      }

      // 4. Получить мастера
      const { data: staffRow, error: staffError } = await (supabase as any)
        .from("staff").select("id").limit(1).single();
      if (staffError || !staffRow) {
        console.error("Staff lookup error:", staffError);
        bookingState.delete(chatId); chatHistory.delete(chatId);
        return "Не удалось найти доступного мастера. Обратитесь к администратору.";
      }

      const appointmentDate = parseAppointmentDate(date);
      const appointmentTime = parseAppointmentTime(time);

      // 5. INSERT appointment
      const { data: appointment, error: appointmentError } = await (supabase as any)
        .from("appointments")
        .insert({
          client_id: clientId,
          service_id: serviceRow.id,
          staff_id: staffRow.id,
          date: appointmentDate,
          start_time: `${appointmentTime}:00`,
          end_time: `${addOneHour(appointmentTime)}:00`,
          status: 'scheduled',
          reminder_sent: false,
          notes: `Источник: Telegram\nКлиент: ${name}\nТелефон: ${phone}\nУслуга: ${service}\nДата: ${date}\nВремя: ${time}`
        })
        .select("id").single();

      if (appointmentError || !appointment) {
        console.error("Appointment insert error:", appointmentError);
        bookingState.delete(chatId); chatHistory.delete(chatId);
        return "Не удалось создать запись. Попробуйте ещё раз или обратитесь к администратору.";
      }

      // 6. Подтверждение клиенту (живым текстом, без служебных данных)
      await sendTelegramMessage(
        chatId,
        `Готово, ${name}! Записала вас на ${service} — ${formatDateForUser(date)} в ${time} ✨\nБудем ждать вас!`
      );

      // 7. Уведомление мастеру/администратору (только в TELEGRAM_CHAT_ID)
      const adminChatId = process.env.TELEGRAM_CHAT_ID;
      console.log("[admin notify] adminChatId =", adminChatId, "| clientChatId =", chatId);
      if (adminChatId) {
        console.log("[admin notify] отправляем уведомление в", Number(adminChatId));
        await sendTelegramMessage(
          Number(adminChatId),
          `🔔 Новая запись!\n\n💇 Услуга: ${service}\n📅 День: ${date}\n🕒 Время: ${time}\n👤 Клиент: ${name}\n📞 Телефон: ${phone}`
        );
        console.log("[admin notify] уведомление отправлено");
      } else {
        console.warn("[admin notify] TELEGRAM_CHAT_ID не задан — уведомление пропущено");
      }

      bookingState.delete(chatId);
      chatHistory.delete(chatId);
      return null; // OpenRouter не вызывается — всё уже отправлено
    }
  }
  // --- конец шаг-машины ---

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

Нужно собрать строго в таком порядке:
1. услугу
2. день
3. время
4. имя
5. телефон

Правила:

- Первое сообщение всегда:
"Здравствуйте! На какую услугу вы хотите записаться?"

- После получения услуги спроси:
"На какой день вы хотите записаться?"

- После получения дня спроси:
"На какое время вам удобно записаться?"

- После получения времени спроси имя. Например: "Отлично, записываю. Подскажите, как вас зовут?"

- После получения имени спроси телефон. Например: "И оставьте, пожалуйста, номер телефона для связи."

- После получения телефона НЕ пиши ничего — система сама обработает запись и ответит клиенту.

Очень важно:
- Никогда не повторяй один и тот же вопрос два раза подряд.
- Никогда не спрашивай информацию, которую клиент уже сообщил.
- Не используй фразы "Отличный выбор", "Замечательно", "Прекрасно" перед каждым вопросом.
- Пиши естественно, как живой администратор салона.
- Отвечай коротко и грамотно.
- Пиши на языке клиента.
- НИКОГДА не используй слова "подтверждена", "оформлена", "ждем вас", "ждём вас".`
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

  // Инициализировать step-машину после первого ответа AI (приветствие)
  const assistantCount = history.filter(m => m.role === 'assistant').length;
  if (!bookingState.has(chatId) && assistantCount === 1) {
    bookingState.set(chatId, { step: 'service', service: '', date: '', time: '', name: '', phone: '' });
    // Первый ответ — отправляем с кнопками услуг (polling не шлёт второй раз)
    const serviceKeyboard = [
      [{ text: '✂️ Стрижка', callback_data: 'service:Стрижка' }, { text: '🎨 Окрашивание', callback_data: 'service:Окрашивание' }],
      [{ text: '💅 Маникюр', callback_data: 'service:Маникюр' }, { text: '✍️ Другая услуга', callback_data: 'service:manual' }]
    ];
    await sendTelegramMessageWithKeyboard(chatId, answer, serviceKeyboard);
    return null;
  }

  // После получения услуги — кнопки дат
  const currentStepAfterAI = bookingState.get(chatId)?.step;
  if (currentStepAfterAI === 'date') {
    await sendTelegramMessageWithKeyboard(chatId, answer, getDateKeyboard());
    return null;
  }

  // После получения даты — кнопки свободного времени
  if (currentStepAfterAI === 'time') {
    const stateForTime = bookingState.get(chatId)!;
    console.log(`[timeKeyboard] stateForTime.date: "${stateForTime.date}"`);
    const parsedDate = parseAppointmentDate(stateForTime.date);
    console.log(`[timeKeyboard] parsedDate passed to getAvailableSlots: "${parsedDate}"`);
    const freeSlots = await getAvailableSlots(parsedDate);

    if (freeSlots.length === 0) {
      // Нет слотов — возвращаем на выбор даты
      bookingState.set(chatId, { ...stateForTime, step: 'date', date: '' });
      const noSlotsMsg = `К сожалению, на выбранную дату нет свободного времени. Выберите другой день:`;
      await sendTelegramMessageWithKeyboard(chatId, noSlotsMsg, getDateKeyboard());
      return null;
    }

    const timeKeyboard: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < freeSlots.length; i += 3) {
      timeKeyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `time:${s}` })));
    }
    await sendTelegramMessageWithKeyboard(chatId, answer, timeKeyboard);
    return null;
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

// POST /api/integrations/telegram/connect
// Принимает { token }, проверяет через getMe, перезапускает polling.
// Токен хранится только в process.env (runtime, до перезапуска сервера).
app.post('/api/integrations/telegram/connect', async (req, res) => {
  const { token } = req.body as { token?: string };

  if (!token || typeof token !== 'string' || token.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const trimmedToken = token.trim();

  // Логируем только маску токена — никогда не полный
  const masked = `${trimmedToken.slice(0, 4)}${'*'.repeat(Math.max(0, trimmedToken.length - 8))}${trimmedToken.slice(-4)}`;
  console.log(`[telegram/connect] Validating token: ${masked}`);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${trimmedToken}/getMe`);
    const tgData = await tgRes.json() as { ok: boolean; result?: { username: string; first_name: string } };

    if (!tgData.ok || !tgData.result) {
      return res.status(400).json({ success: false, error: 'Invalid Telegram token. Check it in @BotFather.' });
    }

    const { username, first_name } = tgData.result;

    // Обновляем токен в runtime process.env
    process.env.TELEGRAM_BOT_TOKEN = trimmedToken;

    // Перезапускаем polling с новым токеном
    restartTelegramPolling();

    console.log(`[telegram/connect] Connected: @${username} (${first_name})`);

    return res.json({ success: true, username, name: first_name });
  } catch (err) {
    console.error('[telegram/connect] Error:', err);
    return res.status(500).json({ success: false, error: 'Could not reach Telegram API' });
  }
});

app.use('/api/clients', clientsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/developer', developerRouter);

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

async function sendTelegramMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: { text: string; callback_data: string }[][]
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: keyboard }
    })
  });
}

async function answerCallbackQuery(callbackQueryId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

async function getAvailableSlots(date: string, excludeAppointmentId?: string): Promise<string[]> {
  const allSlots = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

  console.log(`[slots] date: "${date}"`);
  console.log(`[slots] excludeAppointmentId: "${excludeAppointmentId ?? 'none'}"`);

  const baseQ = (supabase as any).from('appointments').select('start_time').eq('date', date);
  const { data: booked, error: bookedError } = await (
    excludeAppointmentId ? baseQ.neq('id', excludeAppointmentId) : baseQ
  );

  if (bookedError) {
    console.error('[slots] Supabase error:', JSON.stringify(bookedError));
  }

  console.log('[slots] booked rows:', JSON.stringify(booked));
  const bookedTimes = (booked ?? []).map((a: any) => (a.start_time as string).slice(0, 5));
  console.log('[slots] bookedTimes:', JSON.stringify(bookedTimes));
  const freeSlots = allSlots.filter(s => !bookedTimes.includes(s));
  console.log('[slots] freeSlots:', JSON.stringify(freeSlots));
  return freeSlots;
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
let isPolling = false; // предотвращает параллельные тики setInterval
let pollingIntervalId: ReturnType<typeof setInterval> | null = null;

/** Останавливает текущий polling и запускает новый с токеном из process.env */
function restartTelegramPolling() {
  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId);
    pollingIntervalId = null;
    isPolling = false;
    console.log('[polling] Previous polling stopped');
  }
  startTelegramPolling();
}

async function startTelegramPolling() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('Telegram bot token not configured');
    return;
  }

  console.log('Telegram polling started');

  pollingIntervalId = setInterval(async () => {
    // Если предыдущий тик ещё выполняется — пропустить этот
    if (isPolling) return;
    isPolling = true;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset + 1}`
      );

      const data = await response.json();

      if (!data.ok) return;

      for (const update of data.result) {
        telegramOffset = update.update_id;

        // Нажатие на inline-кнопку (услуга / дата / время)
        if (update.callback_query) {
          const cq = update.callback_query;
          const cqChatId: number = cq.message?.chat?.id;
          const cqData: string = cq.data ?? '';

          await answerCallbackQuery(cq.id);

          if (!cqChatId) { continue; }

          // --- Отмена записи ---
          if (cqData.startsWith('cancel_confirm:')) {
            const appointmentId = cqData.slice('cancel_confirm:'.length);
            const { data: apptInfo } = await (supabase as any)
              .from('appointments').select('date, start_time, notes').eq('id', appointmentId).maybeSingle();
            const { error } = await (supabase as any).from('appointments').delete().eq('id', appointmentId);
            if (error) {
              await sendTelegramMessage(cqChatId, 'Не удалось отменить запись. Попробуйте ещё раз.');
            } else {
              manageState.delete(cqChatId);
              await sendTelegramMessage(cqChatId, 'Запись отменена. Будем рады видеть вас снова! 🌸');
              const adminChatId = process.env.TELEGRAM_CHAT_ID;
              if (adminChatId) {
                const info = apptInfo ? formatAppointmentForUser(apptInfo) : `ID: ${appointmentId}`;
                await sendTelegramMessage(Number(adminChatId), `❌ Клиент отменил запись.\n${info}`);
              }
            }
            continue;
          }

          if (cqData === 'cancel_keep') {
            manageState.delete(cqChatId);
            await sendTelegramMessage(cqChatId, 'Хорошо, запись оставлена. Будем ждать вас! 🌸');
            continue;
          }

          if (cqData.startsWith('select_cancel:')) {
            const appointmentId = cqData.slice('select_cancel:'.length);
            const { data: appt } = await (supabase as any)
              .from('appointments').select('id, date, start_time, notes').eq('id', appointmentId).maybeSingle();
            const apptText = appt ? formatAppointmentForUser(appt) : `Запись ${appointmentId}`;
            const keyboard = [[
              { text: '✅ Да, отменить', callback_data: `cancel_confirm:${appointmentId}` },
              { text: '❌ Нет, оставить', callback_data: 'cancel_keep' }
            ]];
            await sendTelegramMessageWithKeyboard(cqChatId, `${apptText}\n\nОтменить эту запись?`, keyboard);
            continue;
          }

          // --- Перенос записи ---
          if (cqData.startsWith('select_reschedule:')) {
            const appointmentId = cqData.slice('select_reschedule:'.length);
            const cur = manageState.get(cqChatId);
            if (cur) manageState.set(cqChatId, { ...cur, step: 'select_new_date', appointmentId });
            const { data: appt } = await (supabase as any)
              .from('appointments').select('id, date, start_time, notes').eq('id', appointmentId).maybeSingle();
            const apptText = appt ? formatAppointmentForUser(appt) : `Запись ${appointmentId}`;
            await sendTelegramMessageWithKeyboard(cqChatId, `${apptText}\n\nВыберите новую дату:`, getRescheduleDateKeyboard(appointmentId));
            continue;
          }

          if (cqData.startsWith('rdate_manual:')) {
            // Пользователь хочет ввести дату вручную — не меняем шаг, ждём текст
            await sendTelegramMessage(cqChatId, 'Напишите дату (например: «завтра», «30 июня»).');
            continue;
          }

          if (cqData.startsWith('rdate:')) {
            // rdate:<appointmentId>:<YYYY-MM-DD>
            // lastIndexOf(':') надёжнее split потому что UUID содержит дефисы, но не двоеточия
            const lastColon = cqData.lastIndexOf(':');
            const dateStr = cqData.slice(lastColon + 1);           // '2026-06-30'
            const appointmentId = cqData.slice('rdate:'.length, lastColon); // UUID
            const newDate = parseAppointmentDate(dateStr);
            console.log(`[rdate] appointmentId="${appointmentId}" dateStr="${dateStr}" parsedDate="${newDate}"`);
            const cur = manageState.get(cqChatId);
            if (cur) manageState.set(cqChatId, { ...cur, step: 'select_new_time', appointmentId, newDate });
            // Исключаем саму переносимую запись, чтобы её слот не блокировался
            const freeSlots = await getAvailableSlots(newDate, appointmentId);
            if (freeSlots.length === 0) {
              await sendTelegramMessageWithKeyboard(cqChatId, 'На эту дату нет свободного времени. Выберите другой день:', getRescheduleDateKeyboard(appointmentId));
            } else {
              const keyboard: { text: string; callback_data: string }[][] = [];
              for (let i = 0; i < freeSlots.length; i += 3) {
                keyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `rtime:${appointmentId}:${s}` })));
              }
              await sendTelegramMessageWithKeyboard(cqChatId, 'Выберите новое время:', keyboard);
            }
            continue;
          }

          if (cqData.startsWith('rtime:')) {
            // rtime:<appointmentId>:<HH>:<MM>  — время HH:MM имеет двоеточие
            const parts = cqData.split(':');
            const appointmentId = parts[1];
            const newTime = `${parts[2]}:${parts[3]}`; // 'HH:MM'
            const cur = manageState.get(cqChatId);
            const newDate = cur?.newDate;
            if (!newDate) {
              await sendTelegramMessage(cqChatId, 'Ошибка: дата не найдена. Начните перенос заново.');
              manageState.delete(cqChatId);
              continue;
            }
            const parsedTime = parseAppointmentTime(newTime);
            // Проверяем слот (исключаем саму переносимую запись)
            const { data: existingSlot } = await (supabase as any)
              .from('appointments').select('id')
              .eq('date', newDate).eq('start_time', `${parsedTime}:00`)
              .neq('id', appointmentId).limit(1).maybeSingle();
            if (existingSlot) {
              // Исключаем саму переносимую запись из занятых слотов
              const freeSlots = await getAvailableSlots(newDate, appointmentId);
              if (freeSlots.length === 0) {
                await sendTelegramMessageWithKeyboard(cqChatId, 'Это время занято, и других свободных слотов на эту дату нет. Выберите другой день:', getRescheduleDateKeyboard(appointmentId));
              } else {
                const keyboard: { text: string; callback_data: string }[][] = [];
                for (let i = 0; i < freeSlots.length; i += 3) {
                  keyboard.push(freeSlots.slice(i, i + 3).map(s => ({ text: s, callback_data: `rtime:${appointmentId}:${s}` })));
                }
                await sendTelegramMessageWithKeyboard(cqChatId, 'Это время уже занято. Выберите другое:', keyboard);
              }
              continue;
            }
            const newEndTime = addOneHour(parsedTime);
            const { error } = await (supabase as any).from('appointments').update({
              date: newDate,
              start_time: `${parsedTime}:00`,
              end_time: `${newEndTime}:00`
            }).eq('id', appointmentId);
            if (error) {
              await sendTelegramMessage(cqChatId, 'Не удалось перенести запись. Попробуйте ещё раз.');
            } else {
              manageState.delete(cqChatId);
              const formattedDate = formatDateForUser(newDate);
              await sendTelegramMessage(cqChatId, `Готово! Запись перенесена на ${formattedDate} в ${newTime} ✨`);
              const adminChatId = process.env.TELEGRAM_CHAT_ID;
              if (adminChatId) {
                await sendTelegramMessage(Number(adminChatId), `🔄 Перенос записи!\n📅 Новая дата: ${formattedDate}\n🕒 Новое время: ${newTime}`);
              }
            }
            continue;
          }

          // Кнопка "Ввести вручную" — просто подсказка, шаг-машину не трогаем
          if (cqData === 'service:manual') {
            await sendTelegramMessage(cqChatId, 'Напишите, какая услуга вас интересует.');
            continue;
          }
          if (cqData === 'date:manual') {
            await sendTelegramMessage(cqChatId, 'Напишите дату в удобном формате — например: «сегодня», «завтра», «30 июня».');
            continue;
          }

          // service:, date:, time: — передаём значение в шаг-машину
          if (cqData.startsWith('service:') || cqData.startsWith('date:') || cqData.startsWith('time:')) {
            const value = cqData.slice(cqData.indexOf(':') + 1);
            const answer = await generateAIResponse(cqChatId, value);
            if (answer !== null) {
              await sendTelegramMessage(cqChatId, answer);
            }
          }
          continue;
        }

        // Обычное текстовое сообщение
        const message = update.message;
        const text = message?.text;
        const chatId = message?.chat?.id;

        if (!text || !chatId) continue;

        const answer = await generateAIResponse(chatId, text);
        if (answer !== null) {
          await sendTelegramMessage(chatId, answer);
        }
      }
    } catch (error) {
      console.error('Telegram polling error', error);
    } finally {
      isPolling = false; // освобождаем флаг в любом случае
    }
  }, 3000);
}

startTelegramPolling();