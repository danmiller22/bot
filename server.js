import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '5mb' }));

const TG_BASE = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const GROUP_ID = process.env.GROUP_CHAT_ID;
const ALLOW_ALL = process.env.ALLOW_ALL === '1';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const upper = (s) => !s ? s : (s[0].toUpperCase() + s.slice(1));
const csv = (s) => new Set((s||'').split(',').map(v=>v.trim()).filter(Boolean));

const ALLOWED_USERNAMES = csv(process.env.ALLOWED_USERNAMES);
const ALLOWED_USER_IDS    = csv(process.env.ALLOWED_USER_IDS);

function isAllowed(from){
  if (ALLOW_ALL) return true;
  const uname = (from?.username||'').toLowerCase();
  if (ALLOWED_USERNAMES.has(uname)) return true;
  if (ALLOWED_USER_IDS.has(String(from?.id))) return true;
  return false;
}

async function tg(method, body){
  const { data } = await axios.post(`${TG_BASE}/${method}`, body);
  return data;
}

function kb(rows){ return { inline_keyboard: rows }; }
function btn(text, data){ return { text, callback_data: data }; }
function mainMenu(){
  return kb([
    [btn('Create report','cmd:new'), btn('Update status','cmd:update')],
    [btn('Close report','cmd:close'), btn('My open tickets','cmd:my')]
  ]);
}

async function getSession(uid){
  const { data, error } = await supabase.from('sessions').select('*').eq('user_id', String(uid)).single();
  if (error && error.code !== 'PGRST116') console.error('getSession', error);
  return data || null;
}
async function setSession(uid, state, dataObj){
  const { error } = await supabase.from('sessions').upsert({
    user_id: String(uid), state, data: dataObj, updated_at: new Date().toISOString()
  });
  if (error) console.error('setSession', error);
}
async function clearSession(uid){
  const { error } = await supabase.from('sessions').delete().eq('user_id', String(uid));
  if (error) console.error('clearSession', error);
}

async function createTicket(draft, owner){
  const { data, error } = await supabase.from('tickets').insert({
    asset_type: draft.asset_type || 'unspecified',
    problem: draft.problem || null,
    plan: draft.plan || null,
    eta: draft.eta || null,
    status: 'new',
    owner_user_id: String(owner),
    needs_photos: !!draft.needs_photos
  }).select('id').single();
  if (error) throw error;
  await supabase.from('events').insert({ ticket_id: data.id, by_user_id: String(owner), action: 'created', payload: draft });
  return data.id;
}

async function addPhoto(ticket_id, file_id, is_final, by){
  await supabase.from('photos').insert({ ticket_id, file_id, is_final });
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'photos_add', payload: { file_id, is_final } });
}

async function updateStatus(ticket_id, status, by){
  await supabase.from('tickets').update({ status }).eq('id', ticket_id);
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'status_change', payload: { status } });
}

async function setETA(ticket_id, eta, by){
  await supabase.from('tickets').update({ eta }).eq('id', ticket_id);
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'eta_change', payload: { eta } });
}

async function myOpenTickets(uid, limit=10){
  const { data, error } = await supabase.from('tickets')
    .select('id, asset_type, problem, plan, eta, status, needs_photos')
    .neq('status','done')
    .eq('owner_user_id', String(uid))
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

function ticketLine(t){
  const asset = t.asset_type ? upper(t.asset_type) : 'Unspecified';
  const eta = t.eta ? ` • ETA: ${new Date(t.eta).toISOString()}` : '';
  const prob = t.problem ? ` • ${t.problem}` : '';
  return `#${t.id} • ${asset}${prob}${eta}`;
}

async function toGroup(text, photo){
  if (!GROUP_ID) return;
  if (photo) await tg('sendPhoto', { chat_id: GROUP_ID, photo, caption: text, parse_mode: 'HTML' });
  else await tg('sendMessage', { chat_id: GROUP_ID, text, parse_mode: 'HTML' });
}

app.post('/', async (req,res) => {
  const upd = req.body || {};
  try {
    if (upd.message){
      const m = upd.message, chat = m.chat || {}, from = m.from || {};
      if (chat.type === 'private'){
        if (!isAllowed(from)) { await tg('sendMessage', { chat_id: chat.id, text: 'Access denied.' }); return res.send('OK'); }

        if (m.photo){
          const ses = await getSession(from.id);
          if (ses?.state){
            const file_id = m.photo[m.photo.length-1].file_id;
            if (ses.state.startsWith('create.')){
              const draft = ses.data || {}; draft.photos = draft.photos || []; draft.photos.push(file_id); draft.needs_photos = false;
              await setSession(from.id, 'create.photos', draft);
              await tg('sendMessage', { chat_id: chat.id, text: 'Photo attached. Add more or press Submit.' });
              return res.send('OK');
            }
            if (ses.state.startsWith('update.addphotos')){
              const ticket_id = ses.data?.ticket_id;
              if (ticket_id) await addPhoto(ticket_id, file_id, false, from.id);
              await tg('sendMessage', { chat_id: chat.id, text: 'Photo added.' });
              await clearSession(from.id);
              return res.send('OK');
            }
          }
        }

        const txt = (m.text||'').trim().toLowerCase();
        if (txt === '/start'){
          await tg('sendMessage',{ chat_id: chat.id, text:'Select an action:', reply_markup: mainMenu() });
          return res.send('OK');
        }
        if (txt === '/new' || txt === 'create report'){
          await setSession(from.id, 'create.asset', { asset_type:'unspecified', needs_photos:true });
          await tg('sendMessage',{ chat_id: chat.id, text:'Select asset type.', reply_markup: { inline_keyboard: [[btn('Truck','new:asset:truck'), btn('Trailer','new:asset:trailer')],[btn('Skip','new:asset:skip')]] } });
          return res.send('OK');
        }
        if (txt === '/update' || txt === 'update status'){
          const open = await myOpenTickets(from.id);
          if (!open.length){ await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' }); return res.send('OK'); }
          const rows = open.map(t => [btn(`#${t.id} ${t.asset_type} ${t.problem||''}`.trim(), `upd:pick:${t.id}`)]);
          await setSession(from.id, 'update.pick', {});
          await tg('sendMessage',{ chat_id: chat.id, text:'Select ticket to update:', reply_markup: { inline_keyboard: rows } });
          return res.send('OK');
        }
        if (txt === '/my' || txt === 'my open tickets'){
          const mine = await myOpenTickets(from.id, 10);
          if (!mine.length) await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' });
          else await tg('sendMessage',{ chat_id: chat.id, text: mine.map(ticketLine).join('\n') });
          return res.send('OK');
        }

        await tg('sendMessage',{ chat_id: chat.id, text:'Use the menu:', reply_markup: mainMenu() });
        return res.send('OK');
      }
      return res.send('OK');
    }

    if (upd.callback_query){
      const cq = upd.callback_query, from = cq.from || {};
      const data = cq.data || '';

      if (!isAllowed(from)){ await tg('answerCallbackQuery',{ callback_query_id: cq.id, text:'Access denied.' }); return res.send('OK'); }

      if (data === 'cmd:new'){
        await setSession(from.id, 'create.asset', { asset_type:'unspecified', needs_photos:true });
        await tg('sendMessage',{ chat_id: from.id, text:'Select asset type.', reply_markup: { inline_keyboard: [[btn('Truck','new:asset:truck'), btn('Trailer','new:asset:trailer')],[btn('Skip','new:asset:skip')]] } });
        return res.send('OK');
      }
      if (data.startsWith('new:asset:')){
        const choice = data.split(':')[2];
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {}; draft.asset_type = (choice==='skip') ? 'unspecified' : choice;
        await setSession(from.id, 'create.problem', draft);
        await tg('sendMessage',{ chat_id: from.id, text:'Choose a problem.', reply_markup: { inline_keyboard: [[btn('Tire','new:problem:Tire'), btn('Brakes','new:problem:Brakes'), btn('Electrical','new:problem:Electrical')],[btn('Leak','new:problem:Leak'), btn('Engine','new:problem:Engine'), btn('Other','new:problem:other')],[btn('Skip','new:problem:skip')]] } });
        return res.send('OK');
      }
      if (data.startsWith('new:problem:')){
        const choice = data.split(':')[2];
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {}; draft.problem = (choice==='skip' || choice==='other') ? 'Unspecified' : choice;
        await setSession(from.id, 'create.plan', draft);
        await tg('sendMessage',{ chat_id: from.id, text:'Select action plan.', reply_markup: { inline_keyboard: [[btn('Mobile repair','new:plan:Mobile repair'), btn('Tow','new:plan:Tow')],[btn('Shop appointment','new:plan:Shop appointment'), btn('Waiting for vendor','new:plan:Waiting for vendor')],[btn('Other','new:plan:other'), btn('Skip','new:plan:skip')]] } });
        return res.send('OK');
      }
      if (data.startsWith('new:plan:')){
        const choice = data.split(':')[2];
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {}; draft.plan = (choice==='skip' || choice==='other') ? 'Unspecified' : choice;
        await setSession(from.id, 'create.eta', draft);
        await tg('sendMessage',{ chat_id: from.id, text:'Set ETA.', reply_markup: { inline_keyboard: [[btn('Today','new:eta:today'), btn('+24h','new:eta:+24h'), btn('+48h','new:eta:+48h')],[btn('Set time…','new:eta:set'), btn('Skip','new:eta:skip')]] } });
        return res.send('OK');
      }
      if (data.startsWith('new:eta:')){
        const choice = data.split(':')[2];
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {};
        if (choice === 'today'){ const d = new Date(); d.setHours(23,59,0,0); draft.eta = d.toISOString(); }
        else if (choice === '+24h'){ draft.eta = new Date(Date.now()+24*3600*1000).toISOString(); }
        else if (choice === '+48h'){ draft.eta = new Date(Date.now()+48*3600*1000).toISOString(); }
        else if (choice === 'set'){ await setSession(from.id, 'create.eta.set', draft); await tg('sendMessage',{ chat_id: from.id, text:'Enter ETA (YYYY-MM-DD HH:MM)' }); return res.send('OK'); }
        else if (choice === 'skip'){ draft.eta = new Date(Date.now()+24*3600*1000).toISOString(); }
        await setSession(from.id, 'create.photos', draft);
        await tg('sendMessage',{ chat_id: from.id, text:'Attach 1–5 photos (required). Or press Skip to mark as Needs photos.', reply_markup: { inline_keyboard: [[btn('Skip','new:photos:skip'), btn('Submit','new:submit')]] } });
        return res.send('OK');
      }
      if (data === 'new:photos:skip' || data === 'new:submit'){
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {};
        if (data === 'new:photos:skip') draft.needs_photos = true;
        const id = await createTicket(draft, from.id);
        await clearSession(from.id);
        const caption = `#${id} • ${upper(draft.asset_type||'unspecified')}${draft.problem? ' • '+draft.problem:''}\nPlan: ${draft.plan||'Unspecified'}${draft.eta? ' • ETA: '+draft.eta:''}\nBy: @${from.username||from.id}`;
        const photo = (draft.photos && draft.photos[0]) ? draft.photos[0] : null;
        await toGroup(caption, photo);
        await tg('sendMessage',{ chat_id: from.id, text:`Ticket #${id} created.`, reply_markup: mainMenu() });
        return res.send('OK');
      }

      await tg('answerCallbackQuery',{ callback_query_id: cq.id, text:'OK' });
      return res.send('OK');
    }

    res.send('OK');
  } catch (e){
    console.error('webhook error', e);
    res.send('OK');
  }
});

// cron stub
app.get('/cron', (req,res)=> res.json({ok:true, note:"wire cron-job.org hourly to this endpoint"}));

app.get('/', (req,res)=> res.json({ ok:true, service:'fleet-repair-bot', time:new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Listening on :${PORT}`));
