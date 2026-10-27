# 🪞 Mirror

Encrypted screen mirroring from your **macOS / Linux** machine to your **FreeBSD**
box — entirely through the web browser. No native capture code, no VNC server, no
X11 forwarding.

## How it works

The browser's `getDisplayMedia()` API captures your screen using the operating
system's own screen-sharing permission dialogs (macOS ScreenCaptureKit, Linux
PipeWire). The captured video is streamed **peer-to-peer over WebRTC**, which
encrypts all media with **DTLS-SRTP** — encryption is mandatory in WebRTC and
cannot be turned off.

```
macOS / Linux browser              FreeBSD browser
   (SHARER)                           (VIEWER)
getDisplayMedia() ──┐             ┌── <video>
                    │             │
         WebRTC media (DTLS-SRTP, encrypted, peer-to-peer)
                    │             │
                    └──► encrypted screen stream ◄──┘

        both briefly talk to the signaling server
        (WSS/TLS) only to exchange SDP + ICE, never media
```

A small Node.js server does two jobs:
1. Serves the web UI over **HTTPS** (required — `getDisplayMedia` needs a secure context).
2. Relays WebRTC **signaling** (tiny SDP/ICE JSON messages) over **WSS**, inside
   rooms gated by a **shared secret**.

The screen video itself never passes through the server.

## Encryption summary

| Layer                | Protection                                    |
| -------------------- | --------------------------------------------- |
| Screen video / audio | WebRTC **DTLS-SRTP** (always on)              |
| Signaling (SDP/ICE)  | **TLS** (WSS)                                 |
| Access control       | Shared room **secret** (constant-time check)  |

## Requirements

- Node.js ≥ 18 on whichever machine runs the server.
- A modern browser on both machines (Chrome/Edge/Firefox on the sharer; any
  modern browser on FreeBSD — Firefox or Chromium both work as the viewer).
- OpenSSL on PATH for cert generation (ships in FreeBSD base; `brew install
  openssl` on macOS; `apt/dnf install openssl` on Linux).

## Setup (LAN, self-signed — the default)

Run the server on whichever machine the two can both reach (the sharer itself is
a fine choice on a LAN).

```sh
cd mirror
npm install

# Generate a self-signed cert. LAN IPs + hostname are auto-added to the cert's
# SAN so it validates for your local addresses. Add more hosts if you like:
#   MIRROR_CERT_HOSTS="192.168.1.50,myhost.local" npm run gen-certs
npm run gen-certs

# Start. If you don't set MIRROR_SECRET, a random one is generated and printed.
MIRROR_SECRET="choose-a-strong-secret" npm start
```

The server prints the URLs to open, e.g. `https://192.168.1.50:8443`.

### On the sharer (macOS / Linux)

1. Open `https://<server-ip>:8443/#share` in your browser.
2. Accept the one-time self-signed certificate warning.
3. Enter the **room name** and **shared secret**, click **Start sharing**.
4. Pick the screen/window in the OS dialog. The **mouse cursor is shared** too
   (captured with `cursor: 'always'`).

### On the viewer (FreeBSD)

1. Open `https://<server-ip>:8443/#view`.
2. Accept the certificate warning.
3. Enter the **same room name and secret**, click **Connect**.
4. The remote screen appears. Use **⛶ Fullscreen** for a full-screen mirror.

## Configuration

| Env var             | Default            | Purpose                                      |
| ------------------- | ------------------ | -------------------------------------------- |
| `MIRROR_PORT`       | `8443`             | Listen port                                  |
| `MIRROR_HOST`       | `0.0.0.0`          | Bind address                                 |
| `MIRROR_SECRET`     | random (printed)   | Shared room secret                           |
| `MIRROR_CERT`       | `certs/cert.pem`   | TLS certificate path                         |
| `MIRROR_KEY`        | `certs/key.pem`    | TLS private key path                         |
| `MIRROR_NO_TLS`     | unset              | `1` = plain HTTP (only behind a TLS proxy)   |
| `MIRROR_CERT_HOSTS` | —                  | Extra hostnames/IPs for the cert SAN         |

## Using it over the internet (optional)

On a LAN this works with no STUN/TURN — browsers connect via local host
candidates. Across the internet / behind NAT, expand **Advanced** in the UI and
provide a TURN server (e.g. [coturn](https://github.com/coturn/coturn)). The
media stays encrypted even when relayed through TURN.

## Security notes

- Certificates are self-signed; you trust them once per browser. For a
  phishing-resistant setup, import the generated `certs/cert.pem` into each
  machine's trust store.
- The room secret is the only access gate — use a strong value and keep it off
  shared channels.
- `certs/` and `*.pem` are git-ignored so keys never land in the repo.

## License

MIT
