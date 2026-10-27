// Mirror — WebRTC client for both sharer and viewer.
//
// Flow:
//   SHARER  : getDisplayMedia() -> add tracks -> createOffer -> send via WS.
//   VIEWER  : receive offer -> createAnswer -> render incoming track in <video>.
// ICE candidates are trickled through the signaling WebSocket in both directions.
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
  teardown();
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
// Signaling socket
// ---------------------------------------------------------------------------
function connectSignaling() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/signal`);
    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          type: 'join',
          room: ui.room.value.trim() || 'home',
          secret: ui.secret.value,
          role,
        })
      );
    };
    sock.onmessage = (ev) => handleSignal(JSON.parse(ev.data), resolve, reject);
    sock.onerror = () => reject(new Error('signaling connection failed'));
    sock.onclose = (ev) => {
      if (ev.code === 4401) {
        setStatus('Unauthorized — wrong shared secret.', 'err');
        reject(new Error('unauthorized'));
      }
    };
    ws = sock;
  });
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
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      break;

    case 'ice':
      try {
        if (msg.candidate) await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        console.warn('addIceCandidate failed', e);
      }
      break;

    case 'peer-left':
      setStatus('Peer disconnected.', 'err');
      if (role === 'viewer') ui.video.srcObject = null;
      break;

    case 'bye':
      setStatus('Session ended by peer.', '');
      teardown();
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
    const s = pc.connectionState;
    if (s === 'connected') setStatus('🔒 Connected — encrypted stream live.', 'ok');
    else if (s === 'failed') setStatus('Connection failed. On the internet? Configure TURN.', 'err');
    else if (s === 'disconnected') setStatus('Connection interrupted…', 'err');
  };

  // Viewer renders whatever track arrives.
  pc.ontrack = (ev) => {
    ui.video.srcObject = ev.streams[0];
    ui.stageInfo.textContent = 'Receiving remote screen';
    show(ui.stage);
  };

  return pc;
}

async function startNegotiation() {
  if (role !== 'sharer' || makingOffer) return;
  try {
    makingOffer = true;
    const offer = await pc.createOffer();
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
// Start (role-specific)
// ---------------------------------------------------------------------------
ui.go.onclick = async () => {
  if (!ui.secret.value) {
    setStatus('Enter the shared secret (printed by the server).', 'err');
    return;
  }
  try {
    ui.go.disabled = true;

    if (role === 'sharer') {
      // Prompt the OS screen-capture picker. This uses the native macOS /
      // Linux(PipeWire) capture permission dialogs — no native code needed.
      setStatus('Select a screen or window to share…');
      localStream = await navigator.mediaDevices.getDisplayMedia({
        // cursor: 'always' forces the mouse pointer to be composited into the
        // captured stream (some browsers omit it by default). 'motion' would
        // only show it while moving — we want it always visible to the viewer.
        video: {
          frameRate: { ideal: 30, max: 60 },
          cursor: 'always',
        },
        // Top-level hint as well — browsers differ on where they read `cursor`.
        cursor: 'always',
        audio: false,
      });
      // Show a local preview and stop if the user ends capture from the OS.
      ui.video.srcObject = localStream;
      ui.video.muted = true;
      ui.stageInfo.textContent = 'Sharing this screen (local preview)';
      localStream.getVideoTracks()[0].addEventListener('ended', () => {
        setStatus('Screen capture stopped.', '');
        hangup();
      });
      show(ui.stage);

      createPeerConnection();
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    } else {
      createPeerConnection();
    }

    await connectSignaling();
    // If a viewer joins an already-active room, nudge negotiation.
  } catch (err) {
    console.error(err);
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

ui.hangup.onclick = hangup;

function hangup() {
  sendSignal({ type: 'bye' });
  teardown();
  ui.go.disabled = false;
  show(ui.connect);
  setStatus('Stopped.', '');
}

function teardown() {
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
