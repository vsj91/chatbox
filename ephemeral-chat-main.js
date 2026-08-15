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
const searchStatusEl = el('searchStatus'), cancelBtn = el('cancelSearch'), debugEl = () => el('debug'), toggleDebug = el('toggleDebug'), statusSmall = el('statusSmall')

let userId = crypto.randomUUID()
let nickname = null
let roomId = null
let messagesSub = null
let pollHandle = null
let waitingPoll = null

// debug logger (in-app)
function logDebug(msg){
  try{
    const d = debugEl()
    if(!d) return
    const line = document.createElement('div')
    line.textContent = `${new Date().toLocaleTimeString()} — ${msg}`
    d.appendChild(line)
    d.scrollTop = d.scrollHeight
  }catch(e){ console.log('debug log fail', e) }
}

// helper
const setStatus = (txt) => { connectBtn.textContent = txt; if (statusSmall) statusSmall.textContent = txt }

async function updateWaitingCount(){
  try{
    const res = await supabase.from('waiting').select('*', { head: true, count: 'exact' })
    if (res && typeof res.count === 'number'){
      searchStatusEl.textContent = `In queue: ${res.count} waiting`;
      logDebug(`Queue: ${res.count}`)
      return
    }
  }catch(e){ console.warn('head count failed', e) }
  try{
    const { data } = await supabase.from('waiting').select('id').limit(100)
    searchStatusEl.textContent = `In queue: ${(data||[]).length} waiting`;
    logDebug(`Queue fallback: ${(data||[]).length}`)
  }catch(e){ console.warn('waiting count failed', e) }
}

function stopWaitingPoll(){ if (waitingPoll){ clearInterval(waitingPoll); waitingPoll = null } searchStatusEl.textContent = 'Idle'; cancelBtn.classList.add('hidden') }

cancelBtn.onclick = async () => {
  try{ await supabase.from('waiting').delete().eq('user_id', userId) }catch(e){ console.warn('cancel failed', e); logDebug('cancel failed') }
  if (pollHandle){ clearInterval(pollHandle); pollHandle = null }
  stopWaitingPoll()
  connectBtn.disabled = false
  connectBtn.classList.remove('searching')
  setStatus('Connect & Find a Vibe')
}

toggleDebug.onclick = () => {
  const d = debugEl()
  if(!d) return
  d.classList.toggle('hidden')
  toggleDebug.textContent = d.classList.contains('hidden') ? 'Show Debug' : 'Hide Debug'
}

connectBtn.onclick = async () => {
  nickname = nickInput.value.trim() || ('anon-' + userId.slice(0,6))
  connectBtn.disabled = true
  connectBtn.classList.add('searching')
  setStatus('Searching for a vibe... ✨')
  searchStatusEl.textContent = 'Searching...'
  cancelBtn.classList.remove('hidden')
  logDebug(`Attempting match as ${nickname} (${userId})`)

  // Attempt atomic match via RPC (match_pair signature)
  // Active matching: try immediate RPC then retry for 10s
  let matchedRoom = null
  try {
    const r = await supabase.rpc('match_pair', { p_nickname: nickname, p_user_id: userId })
    if (r.error) { logDebug('match_pair error: ' + (r.error.message || JSON.stringify(r.error))) }
    else if (r.data) { matchedRoom = r.data }
  } catch (e) { console.warn('rpc immediate failed', e); logDebug('rpc immediate failed: ' + (e.message || e)) }

  if (matchedRoom) {
    roomId = matchedRoom
    logDebug('Matched immediately: ' + roomId)
    stopWaitingPoll()
    startChat()
    return
  }

  // retry loop for active 10s window
  const activeWindowMs = 10000
  const retryIntervalMs = 1500
  const startTime = Date.now()
  const activeRetryHandle = setInterval(async () => {
    if (Date.now() - startTime > activeWindowMs) {
      clearInterval(activeRetryHandle)
      logDebug('Active 10s search ended; switching to passive waiting')
      await updateWaitingCount().catch(() => {})
      waitingPoll = setInterval(updateWaitingCount, 2500)
      return
    }
    try {
      const r = await supabase.rpc('match_pair', { p_nickname: nickname, p_user_id: userId })
      if (r.error) { logDebug('retry match_pair error: ' + (r.error.message || JSON.stringify(r.error))); return }
      if (r.data) {
        clearInterval(activeRetryHandle)
        roomId = r.data
        logDebug('Matched during active retry: ' + roomId)
        if (waitingPoll) { clearInterval(waitingPoll); waitingPoll = null }
        stopWaitingPoll()
        startChat()
      }
    } catch (e) { console.warn('retry failed', e); logDebug('retry failed: ' + (e.message || e)) }
  }, retryIntervalMs)
  if (error) {
    console.error('match_pair error', error)
    logDebug('match_pair error: ' + (error.message || JSON.stringify(error)))
    alert('Error matching: ' + (error.message || 'check console'))
    connectBtn.disabled = false
    setStatus('Connect & Find a Vibe')
    stopWaitingPoll()
    return
  }

  if (data) {
    roomId = data
    logDebug('Matched immediately: ' + roomId)
    stopWaitingPoll()
    startChat()
    return
  }

  // no immediate match: start updating waiting count and polling for assignment
  await updateWaitingCount()
  waitingPoll = setInterval(updateWaitingCount, 2500)

  pollHandle = setInterval(async () => {
    try {
      const { data: p } = await supabase.from('participants').select('room_id,nickname').eq('user_id', userId).maybeSingle()
      if (p && p.room_id) {
        roomId = p.room_id
        partnerTag.textContent = 'Partner: ' + (p.nickname || 'mystery')
        clearInterval(pollHandle)
        if (waitingPoll){ clearInterval(waitingPoll); waitingPoll = null }
        stopWaitingPoll()
        logDebug('Matched via participants table: ' + roomId)
        startChat()
      }
    } catch (e) { console.warn('poll error', e); logDebug('poll error: '+(e.message||e)) }
  }, 2000)

  // also subscribe to participants realtime as faster path
  try {
    const ch = supabase.channel('p:' + userId)
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'participants', filter: `user_id=eq.${userId}` }, payload => {
      const r = payload.new
      if (r?.room_id) {
        logDebug('Realtime participant event: ' + JSON.stringify(r))
        roomId = r.room_id
        partnerTag.textContent = 'Partner: ' + (r.nickname || 'mystery')
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
        if (waitingPoll){ clearInterval(waitingPoll); waitingPoll = null }
        try { ch.unsubscribe() } catch(e){}
        stopWaitingPoll()
        startChat()
      }
    })
    await ch.subscribe()
  } catch (e) { console.warn('realtime subscribe failed', e); logDebug('realtime subscribe failed'); }
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
  logDebug('Starting chat for room: ' + roomId)

  // load recent messages
  try {
    const { data } = await supabase.from('messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true })
    messagesEl.innerHTML = (data || []).map(formatMsg).join('')
    messagesEl.scrollTop = messagesEl.scrollHeight
  } catch (e) { console.warn('load messages failed', e); logDebug('load messages failed: '+e.message) }

  // subscribe to new messages for this room (realtime v2 channel)
  try {
    messagesSub = supabase.channel('messages:' + roomId)
    messagesSub.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, payload => {
      messagesEl.insertAdjacentHTML('beforeend', formatMsg(payload.new))
      messagesEl.scrollTop = messagesEl.scrollHeight
    })
    await messagesSub.subscribe()
  } catch (e) { console.warn('messages subscribe failed', e); logDebug('messages subscribe failed') }

  setStatus('Connected')
}

msgForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const content = msgInput.value.trim()
  if (!content || !roomId) return
  try {
    await supabase.from('messages').insert({ room_id: roomId, user_id: userId, nickname, content })
    msgInput.value = ''
  } catch (e) { console.warn('send failed', e); logDebug('send failed: '+(e.message||e)) }
})

async function leave(){
  if (!roomId) return location.reload()
  try { await supabase.from('participants').delete().eq('user_id', userId) } catch(e){ logDebug('leave: delete participant failed') }
  try { await supabase.from('rooms').delete().eq('id', roomId) } catch(e){ logDebug('leave: delete room failed') }
  if (messagesSub) { try { await messagesSub.unsubscribe() } catch(e){} }
  location.reload()
}

disconnectBtn.onclick = leave

// best-effort cleanup
window.addEventListener('beforeunload', async () => {
  try { await supabase.from('participants').delete().eq('user_id', userId) } catch(e){}
})
