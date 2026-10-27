// Generate a self-signed TLS certificate + key for local/personal use.
//
// Uses OpenSSL if available (produces a proper X.509 cert with SANs). This keeps
// the project dependency-free while still yielding a cert browsers can accept
// after a one-time manual trust prompt.
//
// Output: certs/cert.pem and certs/key.pem
//
// Override the subject/SAN hosts with:  MIRROR_CERT_HOSTS="myhost,192.168.1.10"

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CERT_DIR = path.join(ROOT, 'certs');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');

fs.mkdirSync(CERT_DIR, { recursive: true });

// Collect hostnames/IPs for the Subject Alternative Name extension so the cert
// validates for localhost, this machine's hostname, and its LAN IPs.
function collectSan() {
  const hosts = new Set(['localhost']);
  const ips = new Set(['127.0.0.1', '::1']);

  const extra = (process.env.MIRROR_CERT_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of extra) {
    if (/^[0-9.]+$/.test(e) || e.includes(':')) ips.add(e);
    else hosts.add(e);
  }

  hosts.add(os.hostname());
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (!addr.internal) ips.add(addr.address);
    }
  }
  return { hosts: [...hosts], ips: [...ips] };
}

// Render SAN entries for an OpenSSL config file.
function sanConfLines({ hosts, ips }) {
  const lines = [];
  let i = 1;
  for (const h of hosts) lines.push(`DNS.${i++} = ${h}`);
  i = 1;
  for (const ip of ips) lines.push(`IP.${i++} = ${ip}`);
  return lines.join('\n');
}

function haveOpenSSL() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const san = collectSan();

// --- Primary path: OpenSSL (present in macOS/Linux/FreeBSD) ----------------
function genWithOpenSSL() {
  const confPath = path.join(CERT_DIR, 'openssl.cnf');
  const conf = `
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_ext

[dn]
CN = mirror.local

[v3_ext]
basicConstraints = critical, CA:FALSE
keyUsage         = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = @alt_names

[alt_names]
${sanConfLines(san)}
`;
  fs.writeFileSync(confPath, conf);
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
       '-keyout', KEY_PATH, '-out', CERT_PATH, '-days', '825', '-config', confPath],
      { stdio: 'inherit' }
    );
  } finally {
    fs.rmSync(confPath, { force: true });
  }
}

// --- Fallback: pure-JS `selfsigned` (no system OpenSSL required) ------------
// selfsigned v5 is async and signs using Node's native WebCrypto (no node-forge).
async function genWithSelfsigned() {
  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch {
    console.error(
      '[gen-certs] Neither OpenSSL nor the "selfsigned" package is available.\n' +
        '  Run "npm install" first, or install OpenSSL (FreeBSD: base system;\n' +
        '  macOS: `brew install openssl`; Linux: `apt/dnf install openssl`).'
    );
    process.exit(1);
  }
  const altNames = [
    ...san.hosts.map((value) => ({ type: 2, value })), // type 2 = DNS
    ...san.ips.map((ip) => ({ type: 7, ip })),          // type 7 = IP
  ];
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setDate(notAfterDate.getDate() + 825);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'mirror.local' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH, pems.private);
}

async function main() {
  if (haveOpenSSL()) {
    console.log('[gen-certs] Using OpenSSL.');
    genWithOpenSSL();
  } else {
    console.log('[gen-certs] OpenSSL not found — using pure-JS "selfsigned" fallback.');
    await genWithSelfsigned();
  }

  // Lock down the private key.
  fs.chmodSync(KEY_PATH, 0o600);
  console.log(`\n[gen-certs] Wrote:\n  ${CERT_PATH}\n  ${KEY_PATH}`);
  console.log('[gen-certs] Self-signed; browsers warn once. Accept the warning to proceed.');
}

main().catch((err) => {
  console.error('[gen-certs] Failed:', err?.message || err);
  process.exit(1);
});
