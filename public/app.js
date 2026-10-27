// Mirror — WebRTC client for both sharer and viewer, with a resilience layer
// that keeps the stream alive as long as possible across network blips,
// server restarts, ICE path failures, and (where the OS allows) capture loss.
//
// Flow:
//   SHARER  : getDisplayMedia() -> add tracks -> createOffer -> send via WS.
//   VIEWER  : receive offer -> createAnswer -> render incoming track in <video>.
// ICE candidates are trickled through the signaling WebSocket in both directions.
//
// Resilience:
//   - Signaling WebSocket auto-reconnects with exponential backoff + heartbeat.
//   - On ICE 'failed'/'disconnected' we attempt an ICE restart before tearing down.
//   - Sharer re-acquires capture automatically when a track ends unexpectedly
//     (a real OS log-off still needs a fresh user grant; lock/transient drops
//     can recover silently).
//   - Viewer keeps waiting and re-renders whenever the sharer returns.
//
// Media is encrypted by WebRTC itself (DTLS-SRTP). The signaling socket is WSS.

const $ = (id) => document.getElementById(id);

const ui = {
  chooser: $('chooser'),
  connect: $('connect'),
  stage: $('stage'),
  connectTitle: $('connectTitle'),
  room: $('room'),
  secret: $('secret'),
  iceUrl: $('iceUrl'),
  iceUser: $('iceUser'),
  iceCred: $('iceCred'),
  go: $('go'),
  back: $('back'),
  status: $('status'),
  stageInfo: $('stageInfo'),
  video: $('video'),
  fullscreen: $('fullscreen'),
  hangup: $('hangup'),
};

let role = null; // 'sharer' | 'viewer'
let ws = null;
let pc = null;
let localStream = null;
let makingOffer = false;

// --- Resilience state ------------------------------------------------------
// sessionActive is the user's intent: true from "Start/Connect" until an
// explicit Stop/Back. All auto-recovery only runs while this is true, so a
// deliberate hangup never triggers a reconnect loop.
let sessionActive = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let iceRestartInFlight = false;
let recapturing = false;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;
const HEARTBEAT_MS = 15000;

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
function show(section) {
  for (const el of [ui.chooser, ui.connect, ui.stage]) el.classList.add('hidden');
  section.classList.remove('hidden');
}

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
}

function setStageInfo(text) {
  ui.stageInfo.textContent = text;
}

function pickRole(r) {
  role = r;
  ui.connectTitle.textContent = r === 'sharer' ? '📡 Share this screen' : '📺 View a shared screen';
  ui.go.textContent = r === 'sharer' ? 'Start sharing' : 'Connect';
  setStatus('');
  show(ui.connect);
  // Remember choice in the hash so a refresh keeps the role.
  location.hash = r === 'sharer' ? '#share' : '#view';
}

$('pickShare').onclick = () => pickRole('sharer');
$('pickView').onclick = () => pickRole('viewer');
ui.back.onclick = () => {
  stopSession();
  location.hash = '';
  show(ui.chooser);
};

// Honor a role in the URL hash on load (so you can bookmark #share / #view).
if (location.hash === '#share') pickRole('sharer');
else if (location.hash === '#view') pickRole('viewer');

// ---------------------------------------------------------------------------
// ICE server configuration
// ---------------------------------------------------------------------------
function buildIceServers() {
  const servers = [];
  const url = ui.iceUrl.value.trim();
  if (url) {
    if (url.startsWith('turn:') || url.startsWith('turns:')) {
      servers.push({ urls: url, username: ui.iceUser.value, credential: ui.iceCred.value });
    } else {
      servers.push({ urls: url });
    }
  }
  // On a LAN, no STUN/TURN is needed — host candidates connect directly.
  // Leaving this empty keeps everything on the local network.
  return servers;
}

// ---------------------------------------------------------------------------
// Signaling socket (with auto-reconnect + heartbeat)
// ---------------------------------------------------------------------------
function connectSignaling() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let settled = false;
    const sock = new WebSocket(`${proto}//${location.host}/signal`);

    sock.onopen = () => {
      reconnectAttempts = 0; // a successful open resets backoff
      sock.send(
        JSON.stringify({
          type: 'join',
          room: ui.room.value.trim() || 'home',
          secret: ui.secret.value,
          role,
        })
      );
      startHeartbeat();
    };

    sock.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') return; // heartbeat ack
      handleSignal(msg, () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    };

    sock.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error('signaling connection failed'));
      }
    };

    sock.onclose = (ev) => {
      stopHeartbeat();
      if (ev.code === 4401) {
        // Auth failure is terminal — don't retry a wrong secret.
        setStatus('Unauthorized — wrong shared secret.', 'err');
        sessionActive = false;
        if (!settled) {
          settled = true;
          reject(new Error('unauthorized'));
        }
        return;
      }
      // Any other close while the user still wants the session: reconnect.
      if (sessionActive) scheduleReconnect();
    };

    ws = sock;
  });
}

function scheduleReconnect() {
  if (!sessionActive || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  setStatus(`Signaling lost — reconnecting in ${Math.round(delay / 100) / 10}s…`, 'err');
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!sessionActive) return;
    try {
      await connectSignaling();
      setStatus('Reconnected. Re-establishing stream…', 'ok');
      // Sharer re-offers (with ICE restart) so media resumes on the new socket.
      if (role === 'sharer' && pc) await startNegotiation(true);
    } catch {
      // connectSignaling's onclose will schedule the next attempt.
    }
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendSignal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function handleSignal(msg, resolve, reject) {
  switch (msg.type) {
    case 'joined':
      setStatus(`Joined room "${msg.room}" as ${msg.role}. Waiting for peer…`, 'ok');
      if (resolve) resolve();
      break;

    case 'peer-joined':
      setStatus('Peer connected. Negotiating…', 'ok');
      // The sharer initiates the offer once a viewer appears.
      if (role === 'sharer') await startNegotiation();
      break;

    case 'offer':
      await onRemoteOffer(msg.sdp);
      break;

    case 'answer':
      if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      break;

    case 'ice':
      try {
        if (msg.candidate && pc) await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.warn('addIceCandidate failed', e);
      }
      break;

    case 'peer-left':
      // Don't tear down — the peer may come back. Keep waiting.
      if (role === 'viewer') {
        setStatus('Sharer disconnected — waiting for it to return…', 'err');
        setStageInfo('Waiting for sharer to reconnect…');
      } else {
        setStatus('Viewer disconnected — waiting for a viewer…', 'err');
      }
      break;

    case 'bye':
      // Explicit end from the peer. Honor it fully.
      setStatus('Session ended by peer.', '');
      stopSession();
      show(ui.connect);
      break;

    case 'error':
      setStatus('Server error: ' + msg.error, 'err');
      if (reject) reject(new Error(msg.error));
      break;
  }
}

// ---------------------------------------------------------------------------
// Peer connection
// ---------------------------------------------------------------------------
function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: buildIceServers() });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal({ type: 'ice', candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      setStatus('🔒 Connected — encrypted stream live.', 'ok');
    } else if (s === 'disconnected') {
      // Transient — WebRTC may self-heal. Give it a moment, then ICE-restart.
      setStatus('Connection interrupted — attempting to recover…', 'err');
      maybeIceRestart();
    } else if (s === 'failed') {
      setStatus('Connection failed — restarting ICE…', 'err');
      maybeIceRestart();
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc && pc.iceConnectionState === 'failed') maybeIceRestart();
  };

  // Viewer renders whatever track arrives (including after a recovery).
  pc.ontrack = (ev) => {
    ui.video.srcObject = ev.streams[0];
    setStageInfo('Receiving remote screen');
    show(ui.stage);
  };

  return pc;
}

// Attempt an ICE restart to re-establish the transport path without a full
// teardown. Only the sharer (the offerer) drives this; the viewer answers.
async function maybeIceRestart() {
  if (!sessionActive || !pc || role !== 'sharer' || iceRestartInFlight) return;
  iceRestartInFlight = true;
  try {
    // Only restart if signaling is available to carry the new offer.
    if (ws && ws.readyState === WebSocket.OPEN) {
      await startNegotiation(true);
    }
  } catch (e) {
    console.warn('ICE restart failed', e);
  } finally {
    iceRestartInFlight = false;
  }
}

async function startNegotiation(iceRestart = false) {
  if (role !== 'sharer' || makingOffer || !pc) return;
  try {
    makingOffer = true;
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: pc.localDescription.sdp });
  } finally {
    makingOffer = false;
  }
}

async function onRemoteOffer(sdp) {
  if (!pc) createPeerConnection();
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ type: 'answer', sdp: pc.localDescription.sdp });
}

// ---------------------------------------------------------------------------
// Sharer capture (with auto-restart on unexpected track end)
// ---------------------------------------------------------------------------
async function acquireCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // cursor: 'always' forces the mouse pointer to be composited into the
    // captured stream (some browsers omit it by default).
    video: {
      frameRate: { ideal: 30, max: 60 },
      cursor: 'always',
    },
    cursor: 'always', // top-level hint; browsers differ on where they read it
    audio: false,
  });
  localStream = stream;
  ui.video.srcObject = stream;
  ui.video.muted = true;
  setStageInfo('Sharing this screen (local preview)');

  // When the capture track ends, decide: user stopped, or did we lose it?
  stream.getVideoTracks()[0].addEventListener('ended', onCaptureEnded);
  return stream;
}

async function onCaptureEnded() {
  if (!sessionActive) return; // explicit stop already handled
  // Capture dropped unexpectedly (lock screen, VT switch, logoff, etc.).
  // Try to re-acquire. A true logoff forces the OS picker again; lock/transient
  // drops often re-grant silently.
  setStatus('Screen capture dropped — attempting to resume…', 'err');
  setStageInfo('Reacquiring screen capture…');
  await restartCapture();
}

async function restartCapture() {
  if (recapturing || !sessionActive) return;
  recapturing = true;
  try {
    const old = localStream;
    const stream = await acquireCapture();
    // Swap the new video track into the existing peer connection so we don't
    // renegotiate from scratch when possible.
    const newTrack = stream.getVideoTracks()[0];
    const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      await sender.replaceTrack(newTrack);
    } else if (pc) {
      pc.addTrack(newTrack, stream);
      await startNegotiation(); // need a new offer if there was no sender
    }
    // Stop the old, dead stream's tracks.
    if (old && old !== stream) for (const t of old.getTracks()) if (t.readyState === 'ended') t.stop();
    setStatus('🔒 Capture resumed — stream live.', 'ok');
  } catch (err) {
    // The user cancelled the re-grant, or capture is unavailable right now.
    setStatus('Could not resume capture (permission needed). Click “Resume” to retry.', 'err');
    setStageInfo('Capture paused');
    offerManualResume();
  } finally {
    recapturing = false;
  }
}

// Surface a manual resume path by repurposing the hangup button area.
function offerManualResume() {
  ui.hangup.textContent = '▶ Resume';
  ui.hangup.classList.remove('danger');
  ui.hangup.onclick = async () => {
    resetHangupButton();
    await restartCapture();
  };
}

function resetHangupButton() {
  ui.hangup.textContent = '⏹ Stop';
  ui.hangup.classList.add('danger');
  ui.hangup.onclick = userHangup;
}

// ---------------------------------------------------------------------------
// Start (role-specific)
// ---------------------------------------------------------------------------
ui.go.onclick = async () => {
  if (!ui.secret.value) {
    setStatus('Enter the shared secret (printed by the server).', 'err');
    return;
  }
  try {
    ui.go.disabled = true;
    sessionActive = true;
    reconnectAttempts = 0;

    if (role === 'sharer') {
      setStatus('Select a screen or window to share…');
      await acquireCapture();
      show(ui.stage);
      createPeerConnection();
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    } else {
      createPeerConnection();
      setStageInfo('Connecting…');
    }

    await connectSignaling();
  } catch (err) {
    console.error(err);
    sessionActive = false;
    if (err && err.name === 'NotAllowedError') {
      setStatus('Screen-share permission denied.', 'err');
    } else {
      setStatus('Error: ' + (err?.message || err), 'err');
    }
    ui.go.disabled = false;
  }
};

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
ui.fullscreen.onclick = () => {
  if (ui.video.requestFullscreen) ui.video.requestFullscreen();
};

function userHangup() {
  sendSignal({ type: 'bye' });
  stopSession();
  ui.go.disabled = false;
  show(ui.connect);
  setStatus('Stopped.', '');
}

ui.hangup.onclick = userHangup;

// Full, intentional teardown. Clears sessionActive first so no recovery fires.
function stopSession() {
  sessionActive = false;
  resetHangupButton();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  ui.video.srcObject = null;
}

// Try to keep things alive across tab visibility changes: when the viewer tab
// becomes visible again after a sleep, nudge a reconnect if the socket died.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sessionActive) {
    if (!ws || ws.readyState === WebSocket.CLOSED) scheduleReconnect();
  }
});
