import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const TG = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const GROUP_ID = process.env.GROUP_CHAT_ID;
const ALLOW_ALL = process.env.ALLOW_ALL === '1';
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '', { auth: { persistSession: false }});

const csv = (s) => new Set((s||'').split(',').map(v=>v.trim()).filter(Boolean));
const ALLOWED_USERNAMES = csv(process.env.ALLOWED_USERNAMES);
const ALLOWED_USER_IDS  = csv(process.env.ALLOWED_USER_IDS);
const kb  = (rows)=>({ inline_keyboard: rows });
const btn = (text,data)=>({ text, callback_data: data });
const upper = (s)=>!s? s : s[0].toUpperCase()+s.slice(1);
const nowIso = ()=> new Date().toISOString();
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

function isAllowed(from){
  if (ALLOW_ALL) return true;
  const uname = (from?.username||'').toLowerCase();
  if (ALLOWED_USERNAMES.has(uname)) return true;
  if (ALLOWED_USER_IDS.has(String(from?.id))) return true;
  return false;
}

async function tg(method, body){
  const { data } = await axios.post(`${TG}/${method}`, body);
  if (!data.ok) console.log('TG ERR', method, data);
  return data;
}
async function toGroup(text, fileId){
  if (!GROUP_ID) return;
  if (fileId) return tg('sendPhoto', { chat_id: GROUP_ID, photo: fileId, caption: text, parse_mode: 'HTML' });
  return tg('sendMessage', { chat_id: GROUP_ID, text, parse_mode: 'HTML' });
}

function mainMenu(){
  return kb([
    [btn('Create report','cmd:new'), btn('Update status','cmd:update')],
    [btn('Close report','cmd:close'), btn('My open tickets','cmd:my')]
  ]);
}

async function getSession(uid){
  const { data, error } = await supabase.from('sessions').select('*').eq('user_id', String(uid)).single();
  if (error && error.code !== 'PGRST116') console.log('getSession', error);
  return data || null;
}
async function setSession(uid, state, dataObj){
  const { error } = await supabase.from('sessions').upsert({ user_id: String(uid), state, data: dataObj||{}, updated_at: nowIso() });
  if (error) console.log('setSession', error);
}
async function clearSession(uid){
  const { error } = await supabase.from('sessions').delete().eq('user_id', String(uid));
  if (error) console.log('clearSession', error);
}

async function createTicket(draft, owner){
  const { data, error } = await supabase.from('tickets').insert({
    asset_type: draft.asset_type || 'unspecified',
    asset_id: draft.asset_id || null,
    problem: draft.problem || null,
    plan: draft.plan || null,
    eta: draft.eta || null,
    status: 'new',
    owner_user_id: String(owner),
    needs_photos: !!draft.needs_photos
  }).select('id').single();
  if (error) throw error;
  await supabase.from('events').insert({ ticket_id: data.id, by_user_id: String(owner), action: 'created', payload: draft, at: nowIso() });
  if (draft.photos?.length){
    const rows = draft.photos.map(f=>({ ticket_id:data.id, file_id:f, is_final:false }));
    await supabase.from('photos').insert(rows);
  }
  return data.id;
}
async function addPhoto(ticket_id, file_id, is_final, by){
  await supabase.from('photos').insert({ ticket_id, file_id, is_final: !!is_final });
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'photos_add', payload: { file_id, is_final }, at: nowIso() });
}
async function updateStatus(ticket_id, status, by){
  await supabase.from('tickets').update({ status }).eq('id', ticket_id);
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'status_change', payload: { status }, at: nowIso() });
}
async function setETA(ticket_id, eta, by){
  await supabase.from('tickets').update({ eta }).eq('id', ticket_id);
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'eta_change', payload: { eta }, at: nowIso() });
}
async function snooze(ticket_id, hours, by){
  const until = new Date(Date.now()+hours*3600*1000).toISOString();
  await supabase.from('tickets').update({ snooze_until: until }).eq('id', ticket_id);
  await supabase.from('events').insert({ ticket_id, by_user_id: String(by), action: 'snooze', payload: { until }, at: nowIso() });
  return until;
}
async function myOpenTickets(uid, limit=15){
  const { data, error } = await supabase.from('tickets')
    .select('id, asset_type, asset_id, problem, plan, eta, status, needs_photos')
    .neq('status','done').eq('owner_user_id', String(uid))
    .order('id', { ascending:false }).limit(limit);
  if (error) throw error; return data || [];
}
const ticketLine = (t)=>{
  const asset = upper(t.asset_type||'unspecified');
  const idtxt = t.asset_id ? ` ${t.asset_id}` : '';
  const eta = t.eta ? ` • ETA: ${new Date(t.eta).toISOString()}` : '';
  const prob = t.problem ? ` • ${t.problem}` : '';
  return `#${t.id} • ${asset}${idtxt}${prob}${eta}`;
};

app.post('/', async (req,res)=>{
  const upd = req.body || {};
  try {
    if (upd.message){
      const m = upd.message, chat = m.chat || {}, from = m.from || {};
      if (chat.type === 'private'){
        if (!isAllowed(from)) { await tg('sendMessage',{ chat_id: chat.id, text:'Access denied.' }); return res.send('OK'); }

        if (m.photo){
          const ses = await getSession(from.id);
          if (ses?.state){
            const file_id = m.photo[m.photo.length-1].file_id;
            if (ses.state.startsWith('create.')){
              const draft = ses.data || {}; draft.photos = draft.photos || []; draft.photos.push(file_id); draft.needs_photos = false;
              await setSession(from.id, 'create.photos', draft);
              await tg('sendMessage',{ chat_id: chat.id, text:'Photo added. Add more or press Submit.' });
              return res.send('OK');
            }
            if (ses.state.startsWith('update.addphotos')){
              const ticket_id = ses.data?.ticket_id;
              if (ticket_id) await addPhoto(ticket_id, file_id, false, from.id);
              await tg('sendMessage',{ chat_id: chat.id, text:'Photo attached.' });
              await clearSession(from.id);
              return res.send('OK');
            }
            if (ses.state.startsWith('close.photos')){
              const draft = ses.data || {}; draft.photos = draft.photos || []; draft.photos.push(file_id);
              await setSession(from.id, 'close.photos', draft);
              await tg('sendMessage',{ chat_id: chat.id, text:'Closing photo added. Send more or press Close again.' });
              return res.send('OK');
            }
          }
        }

        const textRaw = (m.text||'').trim();
        const text = textRaw.toLowerCase();

        if (text === '/start'){
          await tg('sendMessage',{ chat_id: chat.id, text:'Select an action:', reply_markup: mainMenu() });
          return res.send('OK');
        }
        if (text === '/new' || text === 'create report'){
          await setSession(from.id, 'create.asset', { asset_type:'unspecified', asset_id:null, needs_photos:true, photos:[] });
          await tg('sendMessage',{ chat_id: chat.id, text:'Where is the issue?', reply_markup: kb([[btn('Truck','new:asset:truck'), btn('Trailer','new:asset:trailer')],[btn('Skip','new:asset:skip')]]) });
          return res.send('OK');
        }

        const ses = await getSession(from.id);
        if (ses?.state === 'create.assetId.wait'){
          const draft = ses.data || {};
          draft.asset_id = (text === 'skip') ? null : textRaw;
          await setSession(from.id, 'create.problem.wait', draft);
          await tg('sendMessage',{ chat_id: chat.id, text:'Describe the problem (free text). Or type Skip.' });
          return res.send('OK');
        }
        if (ses?.state === 'create.problem.wait'){
          const draft = ses.data || {};
          draft.problem = (text === 'skip') ? 'Unspecified' : textRaw;
          await setSession(from.id, 'create.plan.wait', draft);
          await tg('sendMessage',{ chat_id: chat.id, text:'Action plan? (free text). Or type Skip.' });
          return res.send('OK');
        }
        if (ses?.state === 'create.plan.wait'){
          const draft = ses.data || {};
          draft.plan = (text === 'skip') ? 'Unspecified' : textRaw;
          await setSession(from.id, 'create.eta', draft);
          await tg('sendMessage',{ chat_id: chat.id, text:'ETA?', reply_markup: kb([[btn('Today','new:eta:today'), btn('+24h','new:eta:+24h'), btn('+48h','new:eta:+48h')],[btn('Set time…','new:eta:set'), btn('Skip','new:eta:skip')]]) });
          return res.send('OK');
        }
        if (ses?.state === 'create.eta.set.wait'){
          const draft = ses.data || {};
          const s = textRaw.replace('T',' ').replace('/', '-');
          const dt = new Date(s);
          draft.eta = isNaN(dt.getTime()) ? null : dt.toISOString();
          await setSession(from.id, 'create.photos', draft);
          await tg('sendMessage',{ chat_id: chat.id, text:'Attach photos (required) or press Skip to mark as “needs photos”. Then Submit.', reply_markup: kb([[btn('Skip','new:photos:skip'), btn('Submit','new:submit')]]) });
          return res.send('OK');
        }

        if (text === '/update' || text === 'update status'){
          const open = await myOpenTickets(from.id);
          if (!open.length){ await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' }); return res.send('OK'); }
          await setSession(from.id, 'update.pick', {});
          await tg('sendMessage',{ chat_id: chat.id, text:'Select ticket to update:', reply_markup: kb(open.map(t=>[btn(`#${t.id} ${t.asset_type} ${t.asset_id||''} ${t.problem||''}`.trim(), `upd:pick:${t.id}`)])) });
          return res.send('OK');
        }
        if (text === '/my' || text === 'my open tickets'){
          const mine = await myOpenTickets(from.id, 15);
          if (!mine.length) await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' });
          else await tg('sendMessage',{ chat_id: chat.id, text: mine.map(ticketLine).join('\\n') });
          return res.send('OK');
        }
        if (text === '/close' || text === 'close report'){
          const open = await myOpenTickets(from.id);
          if (!open.length){ await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' }); return res.send('OK'); }
          await setSession(from.id, 'close.pick', {});
          await tg('sendMessage',{ chat_id: chat.id, text:'Select ticket to close:', reply_markup: kb(open.map(t=>[btn(`#${t.id} ${t.asset_type} ${t.asset_id||''} ${t.problem||''}`.trim(), `close:pick:${t.id}`)])) });
          return res.send('OK');
        }

        await tg('sendMessage',{ chat_id: chat.id, text:'Use the menu:', reply_markup: mainMenu() });
        return res.send('OK');
      }
      return res.send('OK');
    }

    if (upd.callback_query){
      const cq = upd.callback_query, from = cq.from || {}, data = cq.data || '';
      if (!isAllowed(from)){ await tg('answerCallbackQuery',{ callback_query_id: cq.id, text:'Access denied.' }); return res.send('OK'); }

      if (data === 'cmd:new'){
        await setSession(from.id, 'create.asset', { asset_type:'unspecified', asset_id:null, needs_photos:true, photos:[] });
        await tg('sendMessage',{ chat_id: from.id, text:'Where is the issue?', reply_markup: kb([[btn('Truck','new:asset:truck'), btn('Trailer','new:asset:trailer')],[btn('Skip','new:asset:skip')]]) });
        return res.send('OK');
      }
      if (data.startsWith('new:asset:')){
        const choice = data.split(':')[2];
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {}; draft.asset_type = (choice==='skip') ? 'unspecified' : choice;
        await setSession(from.id, 'create.assetId.wait', draft);
        const label = draft.asset_type === 'truck' ? 'Truck #' : (draft.asset_type === 'trailer' ? 'Trailer #' : 'Asset #');
        await tg('sendMessage',{ chat_id: from.id, text:`Enter ${label} (or type Skip).` });
        return res.send('OK');
      }
      if (data.startsWith('new:eta:')){
        const choice = data.split(':')[2];
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {};
        if (choice === 'today'){ const d=new Date(); d.setHours(23,59,0,0); draft.eta = d.toISOString(); }
        else if (choice === '+24h'){ draft.eta = new Date(Date.now()+24*3600*1000).toISOString(); }
        else if (choice === '+48h'){ draft.eta = new Date(Date.now()+48*3600*1000).toISOString(); }
        else if (choice === 'set'){ await setSession(from.id, 'create.eta.set.wait', draft); await tg('sendMessage',{ chat_id: from.id, text:'Enter ETA as YYYY-MM-DD HH:MM' }); return res.send('OK'); }
        else if (choice === 'skip'){ draft.eta = null; }
        await setSession(from.id, 'create.photos', draft);
        await tg('sendMessage',{ chat_id: from.id, text:'Attach photos (required) or press Skip to mark as “needs photos”. Then Submit.', reply_markup: kb([[btn('Skip','new:photos:skip'), btn('Submit','new:submit')]]) });
        return res.send('OK');
      }
      if (data === 'new:photos:skip' || data === 'new:submit'){
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {};
        if (data === 'new:photos:skip') draft.needs_photos = true;
        const id = await createTicket(draft, from.id);
        await clearSession(from.id);
        const cap = `#${id} • ${upper(draft.asset_type||'unspecified')}${draft.asset_id? ' '+draft.asset_id:''}${draft.problem? ' • '+draft.problem:''}\\nPlan: ${draft.plan||'Unspecified'}${draft.eta? ' • ETA: '+draft.eta:''}\\nBy: @${from.username||from.id}`;
        await toGroup(cap, draft.photos?.[0]);
        await tg('sendMessage',{ chat_id: from.id, text:`Ticket #${id} created.`, reply_markup: mainMenu() });
        return res.send('OK');
      }

      if (data === 'cmd:update'){
        const open = await myOpenTickets(from.id);
        if (!open.length){ await tg('sendMessage',{ chat_id: from.id, text:'No open tickets.' }); return res.send('OK'); }
        await setSession(from.id, 'update.pick', {});
        await tg('sendMessage',{ chat_id: from.id, text:'Select ticket to update:', reply_markup: kb(open.map(t=>[btn(`#${t.id} ${t.asset_type} ${t.asset_id||''} ${t.problem||''}`.trim(), `upd:pick:${t.id}`)])) });
        return res.send('OK');
      }
      if (data.startsWith('upd:pick:')){
        const ticket_id = parseInt(data.split(':')[2],10);
        await setSession(from.id, 'update.menu', { ticket_id });
        const rows = [
          [btn('In progress','upd:status:in_progress'), btn('Awaiting parts','upd:status:awaiting_parts')],
          [btn('Vendor scheduled','upd:status:vendor_scheduled'), btn('Done','upd:status:done')],
          [btn('Snooze 2h','upd:snooze:2h'), btn('Change ETA','upd:eta:set')],
          [btn('Add photos','upd:photos:add')]
        ];
        await tg('sendMessage',{ chat_id: from.id, text:`Update ticket #${ticket_id}:`, reply_markup: kb(rows) });
        return res.send('OK');
      }
      if (data.startsWith('upd:status:')){
        const status = data.split(':')[2];
        const ses = await getSession(from.id); const ticket_id = ses?.data?.ticket_id;
        if (ticket_id){
          if (status === 'done'){
            await updateStatus(ticket_id, 'done', from.id);
            await supabase.from('tickets').update({ closed_at: nowIso(), closed_by_user_id: String(from.id) }).eq('id', ticket_id);
            await toGroup(`✅ #${ticket_id} • Closed • by @${from.username||from.id}`);
            await tg('sendMessage',{ chat_id: from.id, text:`Ticket #${ticket_id} closed.` });
          } else {
            await updateStatus(ticket_id, status, from.id);
            await toGroup(`#${ticket_id} • ${status.replace('_',' ')} • by @${from.username||from.id}`);
            await tg('sendMessage',{ chat_id: from.id, text:'Status updated.' });
          }
        }
        await clearSession(from.id);
        return res.send('OK');
      }
      if (data === 'upd:eta:set'){
        const ses = await getSession(from.id);
        if (ses?.data) { await setSession(from.id, 'update.eta.set', ses.data); await tg('sendMessage',{ chat_id: from.id, text:'Enter new ETA (YYYY-MM-DD HH:MM)' }); }
        return res.send('OK');
      }
      if (data === 'upd:photos:add'){
        const ses = await getSession(from.id);
        if (ses?.data) { await setSession(from.id, 'update.addphotos', ses.data); await tg('sendMessage',{ chat_id: from.id, text:'Send photo(s) to attach.' }); }
        return res.send('OK');
      }

      if (data === 'cmd:close'){
        const open = await myOpenTickets(from.id);
        if (!open.length){ await tg('sendMessage',{ chat_id: from.id, text:'No open tickets.' }); return res.send('OK'); }
        await setSession(from.id, 'close.pick', {});
        await tg('sendMessage',{ chat_id: from.id, text:'Select ticket to close:', reply_markup: kb(open.map(t=>[btn(`#${t.id} ${t.asset_type} ${t.asset_id||''} ${t.problem||''}`.trim(), `close:pick:${t.id}`)])) });
        return res.send('OK');
      }
      if (data.startsWith('close:pick:')){
        const ticket_id = parseInt(data.split(':')[2],10);
        await setSession(from.id, 'close.photos', { ticket_id, photos: [] });
        await tg('sendMessage',{ chat_id: from.id, text:`Attach 1–3 completion photos for #${ticket_id} (or Skip). Then press Close again.`, reply_markup: kb([[btn('Skip','close:photos:skip'), btn('Close now','close:submit')]]) });
        return res.send('OK');
      }
      if (data === 'close:photos:skip' || data === 'close:submit'){
        const ses = await getSession(from.id) || { data:{} };
        const draft = ses.data || {}; const ticket_id = draft.ticket_id;
        if (!ticket_id){ await clearSession(from.id); return res.send('OK'); }
        for (const f of (draft.photos||[])) await addPhoto(ticket_id, f, true, from.id);
        await updateStatus(ticket_id, 'done', from.id);
        await supabase.from('tickets').update({ closed_at: nowIso(), closed_by_user_id: String(from.id) }).eq('id', ticket_id);
        await toGroup(`✅ #${ticket_id} • Closed • by @${from.username||from.id}`, draft.photos?.[0]);
        await tg('sendMessage',{ chat_id: from.id, text:`Ticket #${ticket_id} closed.` });
        await clearSession(from.id);
        return res.send('OK');
      }

      await tg('answerCallbackQuery',{ callback_query_id: cq.id, text:'OK' });
      return res.send('OK');
    }

    res.send('OK');
  } catch (e){
    console.log('webhook error', e?.response?.data || e);
    res.send('OK');
  }
});

async function remindersTick(){
  try{
    const h = new Date().getUTCHours();
    if (h>=4 && h<=10) return;
    const { data: rows } = await supabase.from('tickets')
      .select('id, asset_type, asset_id, problem, eta, owner_user_id, last_reminded_at, snooze_until, status')
      .neq('status','done').order('id', { ascending:false }).limit(200);
    const due = (rows||[]).filter(t=>{
      const now = Date.now();
      if (t.snooze_until && new Date(t.snooze_until).getTime()>now) return false;
      if (t.last_reminded_at && (now - new Date(t.last_reminded_at).getTime()) < 55*60*1000) return false;
      return true;
    });
    for (const t of due){
      await tg('sendMessage', {
        chat_id: t.owner_user_id,
        text: `Update for ticket #${t.id} (${t.asset_type}${t.asset_id? ' '+t.asset_id:''}${t.problem? ' • '+t.problem:''})${t.eta? ' • ETA: '+t.eta:''}?`,
        reply_markup: kb([
          [btn('In progress',`upd:quick:${t.id}:in_progress`), btn('Awaiting parts',`upd:quick:${t.id}:awaiting_parts`)],
          [btn('Done',`upd:quick:${t.id}:done`), btn('Snooze 2h',`upd:quick:${t.id}:snooze`)],
          [btn('Change ETA',`upd:quick:${t.id}:eta`), btn('Add photos',`upd:quick:${t.id}:photos`)]
        ])
      });
      await supabase.from('tickets').update({ last_reminded_at: nowIso() }).eq('id', t.id);
      await sleep(150);
    }
  }catch(e){ console.log('remindersTick error', e?.response?.data || e); }
}

setTimeout(()=>{ remindersTick(); setInterval(remindersTick, 60*60*1000); }, 2*60*1000);

app.get('/cron', async (_req,res)=>{ await remindersTick(); res.json({ ok:true }); });
app.get('/', (_req,res)=> res.json({ ok:true, service:'fleet-repair-bot', time: nowIso() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Listening on :${PORT}`));
