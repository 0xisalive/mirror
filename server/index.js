// Mirror — encrypted screen mirroring signaling server.
//
// Responsibilities:
//   1. Serve the static web UI over HTTPS (getDisplayMedia requires a secure context).
//   2. Relay WebRTC signaling (SDP offers/answers + ICE candidates) between the
//      sharer (macOS/Linux) and the viewer (FreeBSD) over a WSS WebSocket.
//
// The actual screen video never touches this server — it flows peer-to-peer over
// WebRTC, encrypted end-to-end with DTLS-SRTP. This process only shuffles small
// JSON signaling messages inside rooms gated by a shared secret.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.MIRROR_PORT || 8443);
const HOST = process.env.MIRROR_HOST || '0.0.0.0';
const CERT_PATH = process.env.MIRROR_CERT || path.join(ROOT, 'certs', 'cert.pem');
const KEY_PATH = process.env.MIRROR_KEY || path.join(ROOT, 'certs', 'key.pem');
// Room secret: the shared password that gates who may join a mirroring session.
// Generated on first run if not supplied, and printed to the console.
let ROOM_SECRET = process.env.MIRROR_SECRET || '';
// Allow running plain HTTP (no TLS). Only sane behind a TLS-terminating proxy,
// or for localhost testing. getDisplayMedia still needs a secure context.
const USE_TLS = process.env.MIRROR_NO_TLS !== '1';

// ---------------------------------------------------------------------------
// Static file serving for the web UI
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  // Normalize and confine to PUBLIC_DIR to prevent path traversal.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Harden a little.
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Build the HTTP(S) server
// ---------------------------------------------------------------------------
function createServer() {
  if (!USE_TLS) {
    console.warn('[mirror] TLS DISABLED (MIRROR_NO_TLS=1). Use only behind a TLS proxy or on localhost.');
    return http.createServer(serveStatic);
  }
  let cert, key;
  try {
    cert = fs.readFileSync(CERT_PATH);
    key = fs.readFileSync(KEY_PATH);
  } catch {
    console.error(
      `[mirror] Could not read TLS cert/key.\n` +
        `  cert: ${CERT_PATH}\n  key:  ${KEY_PATH}\n` +
        `  Run "npm run gen-certs" to create a self-signed pair, or set MIRROR_CERT / MIRROR_KEY.`
    );
    process.exit(1);
  }
  return https.createServer({ cert, key }, serveStatic);
}

// ---------------------------------------------------------------------------
// Signaling: rooms of peers that relay SDP/ICE to each other
// ---------------------------------------------------------------------------
// A room maps roomId -> Set<ws>. Each socket authenticates with the room secret
// in its "join" message before any relaying happens.
const rooms = new Map();

function roomPeers(roomId) {
  let set = rooms.get(roomId);
  if (!set) {
    set = new Set();
    rooms.set(roomId, set);
  }
  return set;
}

// Constant-time secret comparison to avoid timing side channels.
function secretOk(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(ROOM_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastToRoom(roomId, sender, obj) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender) send(peer, obj);
  }
}

function startSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/signal' });

  wss.on('connection', (ws) => {
    ws.isAuthed = false;
    ws.roomId = null;
    ws.role = null;
    ws.isAlive = true;
    // Protocol-level pong (from ws.ping) also marks the socket alive.
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', error: 'bad-json' });
        return;
      }

      // --- Authentication / room join ---------------------------------
      if (msg.type === 'join') {
        if (!secretOk(msg.secret)) {
          send(ws, { type: 'error', error: 'unauthorized' });
          ws.close(4401, 'unauthorized');
          return;
        }
        if (typeof msg.room !== 'string' || !/^[\w-]{1,64}$/.test(msg.room)) {
          send(ws, { type: 'error', error: 'bad-room' });
          return;
        }
        ws.isAuthed = true;
        ws.roomId = msg.room;
        ws.role = msg.role === 'sharer' ? 'sharer' : 'viewer';

        const peers = roomPeers(msg.room);
        peers.add(ws);
        send(ws, { type: 'joined', room: msg.room, role: ws.role, peers: peers.size });
        // Tell existing peers someone new arrived so negotiation can begin.
        broadcastToRoom(msg.room, ws, { type: 'peer-joined', role: ws.role, peers: peers.size });
        return;
      }

      // --- Application-level heartbeat (keeps the stream session alive) ---
      // Clients ping periodically; we ack with pong and mark the socket live.
      if (msg.type === 'ping') {
        ws.isAlive = true;
        send(ws, { type: 'pong' });
        return;
      }

      // --- Everything else requires auth -------------------------------
      if (!ws.isAuthed) {
        send(ws, { type: 'error', error: 'not-joined' });
        return;
      }

      // --- Relay signaling messages to the other peer(s) in the room ---
      if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice' || msg.type === 'bye') {
        broadcastToRoom(ws.roomId, ws, { ...msg, role: ws.role });
        return;
      }

      send(ws, { type: 'error', error: 'unknown-type' });
    });

    ws.on('close', () => {
      if (ws.roomId) {
        const peers = rooms.get(ws.roomId);
        if (peers) {
          peers.delete(ws);
          broadcastToRoom(ws.roomId, ws, { type: 'peer-left', role: ws.role, peers: peers.size });
          if (peers.size === 0) rooms.delete(ws.roomId);
        }
      }
    });

    ws.on('error', () => {
      /* swallow socket-level errors; close handler does cleanup */
    });
  });

  // Reap dead sockets: ping every interval; terminate any that didn't answer
  // the previous round. This frees rooms when a peer vanishes without a clean
  // close (crash, network drop, machine sleep) so reconnects start clean.
  const HEARTBEAT_INTERVAL = 30000;
  const reaper = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_INTERVAL);
  wss.on('close', () => clearInterval(reaper));

  return wss;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function main() {
  if (!ROOM_SECRET) {
    ROOM_SECRET = crypto.randomBytes(18).toString('base64url');
    console.log('\n[mirror] No MIRROR_SECRET set — generated a one-time room secret:');
    console.log(`\n    ${ROOM_SECRET}\n`);
    console.log('[mirror] Share this with your viewer. Set MIRROR_SECRET to make it persistent.\n');
  }

  const server = createServer();
  startSignaling(server);

  server.listen(PORT, HOST, () => {
    const scheme = USE_TLS ? 'https' : 'http';
    console.log(`[mirror] Signaling + UI listening on ${scheme}://${HOST}:${PORT}`);
    console.log(`[mirror] Sharer opens:  ${scheme}://<this-host>:${PORT}/#share`);
    console.log(`[mirror] Viewer opens:  ${scheme}://<this-host>:${PORT}/#view`);
    if (USE_TLS) {
      console.log('[mirror] Self-signed cert? Browsers will warn once — accept to proceed.');
    }
  });
}

main();
