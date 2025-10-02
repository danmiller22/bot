import 'dotenv/config';
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json({ limit: '5mb' }));

// === Telegram ===
const TG_BASE = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const GROUP_ID = process.env.GROUP_CHAT_ID;
const ALLOW_ALL = process.env.ALLOW_ALL === '1';

const csv = (s) => new Set((s||'').split(',').map(v=>v.trim()).filter(Boolean));
const ALLOWED_USERNAMES = csv(process.env.ALLOWED_USERNAMES);
const ALLOWED_USER_IDS  = csv(process.env.ALLOWED_USER_IDS || '');

const kb = (rows)=>({ inline_keyboard: rows });
const btn = (text,data)=>({ text, callback_data: data });
const menu = ()=> kb([
  [btn('Create report','cmd:new'), btn('Update status','cmd:update')],
  [btn('Close report','cmd:close'), btn('My open tickets','cmd:my')]
]);

function isAllowed(from){
  if (ALLOW_ALL) return true;
  const uname = (from?.username||'').toLowerCase();
  if (ALLOWED_USERNAMES.has(uname)) return true;
  if (ALLOWED_USER_IDS.has(String(from?.id))) return true;
  return false;
}

async function tg(method, body){
  const { data } = await axios.post(`${TG_BASE}/${method}`, body);
  if (!data.ok) console.error('TG ERR', method, data);
  return data;
}

// --- Health ---
app.get('/', (_req,res)=> res.json({ ok:true, service:'fleet-repair-bot', time:new Date().toISOString() }));

// --- Minimal working webhook ---
// Отвечает в ЛС на /start и показывает меню. Этого достаточно, чтобы проверить, что всё живо.
app.post('/', async (req,res) => {
  try{
    const upd = req.body || {};
    if (upd.message){
      const m = upd.message, chat = m.chat||{}, from = m.from||{};
      if (chat.type === 'private'){
        if (!isAllowed(from)){
          await tg('sendMessage',{ chat_id: chat.id, text:'Access denied.' });
          return res.send('OK');
        }
        const text = (m.text||'').toLowerCase().trim();
        if (text === '/start' || text === 'menu'){
          await tg('sendMessage',{ chat_id: chat.id, text:'Select an action:', reply_markup: menu() });
          return res.send('OK');
        }
        await tg('sendMessage',{ chat_id: chat.id, text:'Use the menu:', reply_markup: menu() });
        return res.send('OK');
      }
    }
    if (upd.callback_query){
      // просто квитируем, чтобы кнопки не висели
      await tg('answerCallbackQuery', { callback_query_id: upd.callback_query.id, text:'OK' });
      const cid = upd.callback_query.message?.chat?.id;
      if (cid && upd.callback_query.message.chat.type === 'private'){
        await tg('sendMessage',{ chat_id: cid, text:'Menu:', reply_markup: menu() });
      }
      return res.send('OK');
    }
    res.send('OK');
  }catch(e){
    console.error('webhook error', e?.response?.data || e);
    res.send('OK');
  }
});

// --- Cron-заглушка (потом подключим напоминалки) ---
app.get('/cron', (_req,res)=> res.json({ ok:true, note:'wire hourly cron to this URL' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Listening on :${PORT}`));
