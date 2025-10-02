import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// === ENV ===
const TG = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const GROUP_ID = process.env.GROUP_CHAT_ID;
const ALLOW_ALL = process.env.ALLOW_ALL === '1';
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '', { auth: { persistSession: false }});

// === helpers ===
const csv = (s) => new Set((s||'').split(',').map(v=>v.trim()).filter(Boolean));
const ALLOWED_USERNAMES = csv(process.env.ALLOWED_USERNAMES);
const ALLOWED_USER_IDS  = csv(process.env.ALLOWED_USER_IDS);
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

function helpText(){
  return [
    'Commands:',
    '/new — create report',
    '/submit — finish report creation',
    '/my — list my open tickets',
    '/update <id> — update ticket',
    '/status <id> <in_progress|awaiting_parts|vendor_scheduled|done>',
    '/eta <id> <YYYY-MM-DD HH:MM | +24h | +48h>',
    '/snooze <id> <hours>',
    '/addphoto <id> — next photo attaches to this ticket',
    '/close <id> — close ticket (send /addphoto <id> then photo before closing to attach closing photo)',
  ].join('\n');
}

// === DB ===
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

// === parsing ===
function parseCmd(text) {
  const m = text.match(/^\/([a-z_]+)(?:\s+(.+))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2]||'').trim();
  return { cmd, rest };
}

// === webhook ===
app.post('/', async (req,res)=>{
  const upd = req.body || {};
  try{
    if (upd.message){
      const m = upd.message, from = m.from || {}, chat = m.chat || {};
      if (chat.type !== 'private') return res.send('OK');
      if (!isAllowed(from)){ await tg('sendMessage',{ chat_id: chat.id, text:'Access denied.' }); return res.send('OK'); }

      const textRaw = (m.text||'').trim();
      const text = textRaw.toLowerCase();
      const cmd = parseCmd(textRaw);

      // photos in flows or addphoto
      if (m.photo){
        const ses = await getSession(from.id);
        const file_id = m.photo[m.photo.length-1].file_id;
        if (ses?.state === 'create.photos.wait'){
          const draft = ses.data || {}; draft.photos = draft.photos || []; draft.photos.push(file_id); draft.needs_photos = false;
          await setSession(from.id, 'create.photos.wait', draft);
          await tg('sendMessage',{ chat_id: chat.id, text:'Photo added. Send more or /submit or type skip.' });
          return res.send('OK');
        }
        if (ses?.state === 'update.addphoto.wait'){
          const ticket_id = ses.data?.ticket_id;
          if (ticket_id) await addPhoto(ticket_id, file_id, false, from.id);
          await clearSession(from.id);
          await tg('sendMessage',{ chat_id: chat.id, text:'Photo attached.' });
          return res.send('OK');
        }
      }

      // command handling
      if (cmd){
        const { cmd: c, rest } = cmd;

        if (c === 'start'){
          await tg('sendMessage',{ chat_id: chat.id, text: helpText() });
          return res.send('OK');
        }

        if (c === 'new'){
          await setSession(from.id, 'create.asset.wait', { asset_type:'unspecified', asset_id:null, photos:[], needs_photos:true });
          await tg('sendMessage',{ chat_id: chat.id, text: 'Where is the issue? Type: truck / trailer / skip' });
          return res.send('OK');
        }

        if (c === 'submit'){
          const ses = await getSession(from.id);
          if (ses?.state?.startsWith('create.')){
            const id = await createTicket(ses.data || {}, from.id);
            await clearSession(from.id);
            const d = ses.data || {};
            const cap = `#${id} • ${upper(d.asset_type||'unspecified')}${d.asset_id? ' '+d.asset_id:''}${d.problem? ' • '+d.problem:''}\nPlan: ${d.plan||'Unspecified'}${d.eta? ' • ETA: '+d.eta:''}\nBy: @${from.username||from.id}`;
            await toGroup(cap, d.photos?.[0]);
            await tg('sendMessage',{ chat_id: chat.id, text:`Ticket #${id} created.` });
          } else {
            await tg('sendMessage',{ chat_id: chat.id, text:'Nothing to submit. Use /new to start.' });
          }
          return res.send('OK');
        }

        if (c === 'my'){
          const mine = await myOpenTickets(from.id, 20);
          if (!mine.length) await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' });
          else await tg('sendMessage',{ chat_id: chat.id, text: mine.map(ticketLine).join('\n') });
          return res.send('OK');
        }

        if (c === 'update'){
          const id = parseInt(rest,10);
          if (!id){
            const mine = await myOpenTickets(from.id, 15);
            if (!mine.length) await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' });
            else await tg('sendMessage',{ chat_id: chat.id, text: 'Usage: /update <id>\n' + mine.map(ticketLine).join('\n') });
            return res.send('OK');
          }
          await setSession(from.id, 'update.active', { ticket_id:id });
          await tg('sendMessage',{ chat_id: chat.id, text:`Ticket #${id}. Reply with:\n- status in_progress | awaiting_parts | vendor_scheduled | done\n- eta YYYY-MM-DD HH:MM | +24h | +48h\n- snooze 2\n- /addphoto ${id} (then send photo)` });
          return res.send('OK');
        }

        if (c === 'status'){
          const [idStr, status] = rest.split(/\s+/,2);
          const id = parseInt(idStr,10);
          const st = (status||'').trim().toLowerCase();
          const allowed = new Set(['in_progress','awaiting_parts','vendor_scheduled','done']);
          if (!id || !allowed.has(st)){ await tg('sendMessage',{ chat_id: chat.id, text:'Usage: /status <id> <in_progress|awaiting_parts|vendor_scheduled|done>' }); return res.send('OK'); }
          if (st === 'done'){
            await updateStatus(id, 'done', from.id);
            await supabase.from('tickets').update({ closed_at: nowIso(), closed_by_user_id: String(from.id) }).eq('id', id);
            await toGroup(`✅ #${id} • Closed • by @${from.username||from.id}`);
            await tg('sendMessage',{ chat_id: chat.id, text:`Ticket #${id} closed.` });
          } else {
            await updateStatus(id, st, from.id);
            await toGroup(`#${id} • ${st.replace('_',' ')} • by @${from.username||from.id}`);
            await tg('sendMessage',{ chat_id: chat.id, text:'Status updated.' });
          }
          return res.send('OK');
        }

        if (c === 'eta'){
          const m = rest.match(/^(\d+)\s+(.+)$/);
          if (!m){ await tg('sendMessage',{ chat_id: chat.id, text:'Usage: /eta <id> <YYYY-MM-DD HH:MM | +24h | +48h>' }); return res.send('OK'); }
          const id = parseInt(m[1],10); let s = m[2].trim();
          let dt = null;
          if (s === '+24h') dt = new Date(Date.now()+24*3600*1000);
          else if (s === '+48h') dt = new Date(Date.now()+48*3600*1000);
          else {
            s = s.replace('T',' ').replace('/', '-');
            const tmp = new Date(s);
            if (!isNaN(tmp.getTime())) dt = tmp;
          }
          if (!dt){ await tg('sendMessage',{ chat_id: chat.id, text:'Bad time format.' }); return res.send('OK'); }
          await setETA(id, dt.toISOString(), from.id);
          await toGroup(`#${id} • ETA set to ${dt.toISOString()} • by @${from.username||from.id}`);
          await tg('sendMessage',{ chat_id: chat.id, text:'ETA updated.' });
          return res.send('OK');
        }

        if (c === 'snooze'){
          const m = rest.match(/^(\d+)\s+(\d+)h?$/i);
          if (!m){ await tg('sendMessage',{ chat_id: chat.id, text:'Usage: /snooze <id> <hours>' }); return res.send('OK'); }
          const id = parseInt(m[1],10); const hours = parseInt(m[2],10);
          const until = await snooze(id, hours, from.id);
          await tg('sendMessage',{ chat_id: chat.id, text:`Snoozed until ${until}` });
          return res.send('OK');
        }

        if (c === 'addphoto'){
          const id = parseInt(rest,10);
          if (!id){ await tg('sendMessage',{ chat_id: chat.id, text:'Usage: /addphoto <id>' }); return res.send('OK'); }
          await setSession(from.id, 'update.addphoto.wait', { ticket_id:id });
          await tg('sendMessage',{ chat_id: chat.id, text:'Send photo now.' });
          return res.send('OK');
        }

        if (c === 'close'){
          const id = parseInt(rest,10);
          if (!id){
            const mine = await myOpenTickets(from.id, 15);
            if (!mine.length) await tg('sendMessage',{ chat_id: chat.id, text:'No open tickets.' });
            else await tg('sendMessage',{ chat_id: chat.id, text: 'Usage: /close <id>\n(Optional) attach photos via /addphoto <id> before closing.\n' + mine.map(ticketLine).join('\n') });
            return res.send('OK');
          }
          await updateStatus(id, 'done', from.id);
          await supabase.from('tickets').update({ closed_at: nowIso(), closed_by_user_id: String(from.id) }).eq('id', id);
          await toGroup(`✅ #${id} • Closed • by @${from.username||from.id}`);
          await tg('sendMessage',{ chat_id: chat.id, text:`Ticket #${id} closed.` });
          return res.send('OK');
        }

        // unknown command
        await tg('sendMessage',{ chat_id: chat.id, text:'Unknown command.\n\n'+helpText() });
        return res.send('OK');
      } // end if cmd

      // free text within create flow
      const ses = await getSession(from.id);
      if (ses?.state === 'create.asset.wait'){
        const v = text;
        const asset = (v==='truck'||v==='trailer') ? v : (v==='skip' ? 'unspecified' : null);
        if (!asset){ await tg('sendMessage',{ chat_id: chat.id, text:'Type: truck / trailer / skip' }); return res.send('OK'); }
        await setSession(from.id, 'create.assetId.wait', { ...(ses.data||{}), asset_type: asset });
        const label = asset==='truck' ? 'Truck #' : (asset==='trailer' ? 'Trailer #' : 'Asset #');
        await tg('sendMessage',{ chat_id: chat.id, text:`Enter ${label} (or type skip).` });
        return res.send('OK');
      }
      if (ses?.state === 'create.assetId.wait'){
        const v = text;
        const asset_id = (v==='skip') ? null : (m.text||'').trim();
        await setSession(from.id, 'create.problem.wait', { ...(ses.data||{}), asset_id });
        await tg('sendMessage',{ chat_id: chat.id, text:'Describe the problem (free text). Or type skip.' });
        return res.send('OK');
      }
      if (ses?.state === 'create.problem.wait'){
        const v = text;
        const problem = (v==='skip') ? 'Unspecified' : (m.text||'').trim();
        await setSession(from.id, 'create.plan.wait', { ...(ses.data||{}), problem });
        await tg('sendMessage',{ chat_id: chat.id, text:'Action plan? (free text). Or type skip.' });
        return res.send('OK');
      }
      if (ses?.state === 'create.plan.wait'){
        const v = text;
        const plan = (v==='skip') ? 'Unspecified' : (m.text||'').trim();
        await setSession(from.id, 'create.eta.wait', { ...(ses.data||{}), plan });
        await tg('sendMessage',{ chat_id: chat.id, text:'ETA? (YYYY-MM-DD HH:MM | +24h | +48h | skip)' });
        return res.send('OK');
      }
      if (ses?.state === 'create.eta.wait'){
        let eta = null;
        if (text !== 'skip'){
          if (text === '+24h') eta = new Date(Date.now()+24*3600*1000);
          else if (text === '+48h') eta = new Date(Date.now()+48*3600*1000);
          else { const s = textRaw.replace('T',' ').replace('/', '-'); const dt = new Date(s); if (!isNaN(dt.getTime())) eta = dt; }
        }
        await setSession(from.id, 'create.photos.wait', { ...(ses.data||{}), eta: eta? eta.toISOString(): null });
        await tg('sendMessage',{ chat_id: chat.id, text:'Send photos now (any number). When done, send /submit or type skip (will mark “needs photos”).' });
        return res.send('OK');
      }
      if (ses?.state === 'create.photos.wait'){
        if (text === 'skip'){
          const d = ses.data || {}; d.needs_photos = true;
          const id = await createTicket(d, from.id);
          await clearSession(from.id);
          const cap = `#${id} • ${upper(d.asset_type||'unspecified')}${d.asset_id? ' '+d.asset_id:''}${d.problem? ' • '+d.problem:''}\nPlan: ${d.plan||'Unspecified'}${d.eta? ' • ETA: '+d.eta:''}\nBy: @${from.username||from.id}`;
          await toGroup(cap, null);
          await tg('sendMessage',{ chat_id: chat.id, text:`Ticket #${id} created (needs photos).` });
          return res.send('OK');
        }
        await tg('sendMessage',{ chat_id: chat.id, text:'Send photos, then /submit.' });
        return res.send('OK');
      }

      await tg('sendMessage',{ chat_id: chat.id, text: 'Use /start to see commands.' });
      return res.send('OK');
    }

    res.send('OK');
  }catch(e){
    console.log('webhook error', e?.response?.data || e);
    res.send('OK');
  }
});

// === Hourly reminders (built-in) ===
async function remindersTick(){
  try{
    const h = new Date().getUTCHours();
    if (h>=4 && h<=10) return; // quiet hours
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
        text: `Update ticket #${t.id} (${t.asset_type}${t.asset_id? ' '+t.asset_id:''}${t.problem? ' • '+t.problem:''})${t.eta? ' • ETA: '+t.eta:''}\n` +
              `Reply with:\n` +
              `- /status ${t.id} in_progress | awaiting_parts | vendor_scheduled | done\n` +
              `- /eta ${t.id} YYYY-MM-DD HH:MM | +24h | +48h\n` +
              `- /snooze ${t.id} 2\n` +
              `- /addphoto ${t.id} then send photo`
      });
      await supabase.from('tickets').update({ last_reminded_at: nowIso() }).eq('id', t.id);
      await sleep(150);
    }
  }catch(e){ console.log('remindersTick error', e?.response?.data || e); }
}

setTimeout(()=>{ remindersTick(); setInterval(remindersTick, 60*60*1000); }, 2*60*1000);
app.get('/cron', async (_req,res)=>{ await remindersTick(); res.json({ ok:true }); });

// health
app.get('/', (_req,res)=> res.json({ ok:true, service:'fleet-repair-bot', time: nowIso() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Listening on :${PORT}`));
