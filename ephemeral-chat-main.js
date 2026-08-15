import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

// TODO: replace these with your Supabase project's URL and anon key
const SUPABASE_URL = 'https://your-project.supabase.co'
const SUPABASE_KEY = 'public-anon-key'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const el = id => document.getElementById(id)
const loginEl = el('login'), chatEl = el('chat')
const nickInput = el('nick'), connectBtn = el('connect')
const messagesEl = el('messages'), msgForm = el('msgForm'), msgInput = el('msgInput')
const roomInfo = el('roomInfo'), disconnectBtn = el('disconnect')

let userId = crypto.randomUUID()
let nickname = null
let roomId = null
let messagesSub = null

connectBtn.onclick = async () => {
  nickname = nickInput.value.trim() || ('anon-' + userId.slice(0,6))
  connectBtn.disabled = true
  connectBtn.textContent = 'Searching...'

  // Call RPC to atomically match pair or enqueue
  const { data, error } = await supabase.rpc('match_pair', { p_user_id: userId, p_nickname: nickname })
  if (error) {
    alert('Error matching: ' + error.message)
    connectBtn.disabled = false
    connectBtn.textContent = 'Connect & Find Partner'
    return
  }

  if (data) {
    roomId = data
    startChat()
  } else {
    // no match yet — listen for room creation where we're a participant
    const channel = supabase.channel('rooms-watch')
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'participants', filter: `user_id=eq.${userId}` }, payload => {
      roomId = payload.new.room_id
      channel.unsubscribe()
      startChat()
    })
    await channel.subscribe()
  }
}

function formatMsg(m){
  return `<div class="message"><div class="meta"><strong>${escapeHtml(m.nickname)}</strong> · ${new Date(m.created_at).toLocaleTimeString()}</div><div>${escapeHtml(m.content)}</div></div>`
}

function escapeHtml(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}

async function startChat(){
  loginEl.classList.add('hidden')
  chatEl.classList.remove('hidden')
  roomInfo.textContent = 'Room: ' + roomId

  // load recent messages
  const { data } = await supabase.from('messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true })
  messagesEl.innerHTML = data.map(formatMsg).join('')
  messagesEl.scrollTop = messagesEl.scrollHeight

  // subscribe to new messages for this room
  messagesSub = supabase.channel('messages:' + roomId)
  messagesSub.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, payload => {
    messagesEl.insertAdjacentHTML('beforeend', formatMsg(payload.new))
    messagesEl.scrollTop = messagesEl.scrollHeight
  })
  await messagesSub.subscribe()
}

msgForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const content = msgInput.value.trim()
  if (!content || !roomId) return
  await supabase.from('messages').insert({ room_id: roomId, user_id: userId, nickname, content })
  msgInput.value = ''
})

async function leave(){
  if (!roomId) return location.reload()
  // remove participant row for this user
  await supabase.from('participants').delete().eq('user_id', userId)
  // client tries to delete the room; server trigger will remove messages if no participants remain
  await supabase.from('rooms').delete().eq('id', roomId)
  location.reload()
}

disconnectBtn.onclick = leave

// attempt best-effort cleanup on unload
window.addEventListener('beforeunload', async () => {
  try { await supabase.from('participants').delete().eq('user_id', userId) } catch(e){}
})
