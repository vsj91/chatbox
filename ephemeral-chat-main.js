import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

// Replace these with your Supabase project's URL and anon key (set before deploy)
const SUPABASE_URL = 'https://your-project.supabase.co'
const SUPABASE_KEY = 'public-anon-key'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const el = id => document.getElementById(id)
const loginEl = el('login'), chatEl = el('chat')
const nickInput = el('nick'), connectBtn = el('connect')
const messagesEl = el('messages'), msgForm = el('msgForm'), msgInput = el('msgInput')
const roomInfo = el('roomInfo'), partnerTag = el('partnerTag'), disconnectBtn = el('disconnect')

let userId = crypto.randomUUID()
let nickname = null
let roomId = null
let messagesSub = null
let pollHandle = null

// helper
const setStatus = (txt) => { connectBtn.textContent = txt }

connectBtn.onclick = async () => {
  nickname = nickInput.value.trim() || ('anon-' + userId.slice(0,6))
  connectBtn.disabled = true
  connectBtn.classList.add('searching')
  setStatus('Searching for a vibe... ✨')

  // Attempt atomic match via RPC
  const { data, error } = await supabase.rpc('match_pair', { p_user_id: userId, p_nickname: nickname })
  if (error) {
    console.error('match_pair error', error)
    alert('Error matching: ' + (error.message || 'check console'))
    connectBtn.disabled = false
    setStatus('Connect & Find a Vibe')
    return
  }

  if (data) {
    roomId = data
    startChat()
    return
  }

  // fallback: poll participants table every 2s to detect room assignment (reliable if realtime not configured)
  pollHandle = setInterval(async () => {
    try {
      const { data: p } = await supabase.from('participants').select('room_id,nickname').eq('user_id', userId).maybeSingle()
      if (p && p.room_id) {
        roomId = p.room_id
        partnerTag.textContent = 'Partner: ' + (p.nickname || 'mystery')
        clearInterval(pollHandle)
        startChat()
      }
    } catch (e) { console.warn('poll error', e) }
  }, 2000)

  // also subscribe to participants realtime as faster path
  try {
    const ch = supabase.channel('p:' + userId)
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'participants', filter: `user_id=eq.${userId}` }, payload => {
      const r = payload.new
      if (r?.room_id) {
        roomId = r.room_id
        partnerTag.textContent = 'Partner: ' + (r.nickname || 'mystery')
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
        ch.unsubscribe()
        startChat()
      }
    })
    await ch.subscribe()
  } catch (e) { console.warn('realtime subscribe failed', e) }
}

function formatMsg(m){
  const who = m.user_id === userId ? 'me' : 'other'
  return `<div class="message ${who}"><div class="meta"><strong>${escapeHtml(m.nickname || (who==='me'? 'You':'Stranger'))}</strong> · ${new Date(m.created_at).toLocaleTimeString()}</div><div>${escapeHtml(m.content)}</div></div>`
}

function escapeHtml(s){ if(!s) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;') }

async function startChat(){
  loginEl.classList.add('hidden')
  chatEl.classList.remove('hidden')
  roomInfo.textContent = 'Room: ' + roomId

  // load recent messages
  try {
    const { data } = await supabase.from('messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true })
    messagesEl.innerHTML = (data || []).map(formatMsg).join('')
    messagesEl.scrollTop = messagesEl.scrollHeight
  } catch (e) { console.warn('load messages failed', e) }

  // subscribe to new messages for this room (realtime v2 channel)
  try {
    messagesSub = supabase.channel('messages:' + roomId)
    messagesSub.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, payload => {
      messagesEl.insertAdjacentHTML('beforeend', formatMsg(payload.new))
      messagesEl.scrollTop = messagesEl.scrollHeight
    })
    await messagesSub.subscribe()
  } catch (e) { console.warn('messages subscribe failed', e) }

  setStatus('Connected')
}

msgForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const content = msgInput.value.trim()
  if (!content || !roomId) return
  try {
    await supabase.from('messages').insert({ room_id: roomId, user_id: userId, nickname, content })
    msgInput.value = ''
  } catch (e) { console.warn('send failed', e) }
})

async function leave(){
  if (!roomId) return location.reload()
  try { await supabase.from('participants').delete().eq('user_id', userId) } catch(e){}
  try { await supabase.from('rooms').delete().eq('id', roomId) } catch(e){}
  if (messagesSub) { try { await messagesSub.unsubscribe() } catch(e){} }
  location.reload()
}

disconnectBtn.onclick = leave

// best-effort cleanup
window.addEventListener('beforeunload', async () => {
  try { await supabase.from('participants').delete().eq('user_id', userId) } catch(e){}
})
