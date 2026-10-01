// The relay crypto's fixed test vector, shared by test/relay-crypto.test.js (Node) and
// test/relay-crypto.html (browser) so both runtimes are checked against the same bytes. The
// expected values were computed with node:crypto (pbkdf2Sync, hkdfSync, createHmac,
// createCipheriv), an implementation independent of the WebCrypto path the module uses. If this
// fails after a change to public/relay_crypto.js, the change broke compatibility with every
// existing install: see the note at the top of that module.

export const VECTOR = {
  passphrase: 'correct horse battery staple',
  kdf: { alg: 'PBKDF2-SHA256', iter: 600000, salt: 'AAECAwQFBgcICQoLDA0ODw==' },
  master: 'ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6',
  localId: 'ask_123',
  ref: 'AetHDRr4buar0-l_-f2FC2FYOSjqsT5shVLFs31-ZV0',
  iv: 'oKGio6Slpqeoqaqr', // a0a1…ab; fixed only here
  value: { title: 'Pick a hat', n: 1 },
  body: 'bsJSdtDazSh3ig7JYt06fDqmehV2jQQFMcGkUyfrSs8W/BcTVJrX0Xl41So=',
  verifier: 'oKGio6Slpqeoqaqr.ZY1VMtbTxGs0iCjFc998dH+8OxdlnrhBNdFXByFkIM8oj6iybQ==',
  blobPath: 'relay/u1/x.bin',
  blobPlain: [1, 2, 3, 4, 5],
  blob: 'oKGio6SlpqeoqaqrFOIlG6ErT4CFQ9bPtXPJFdvZMU8g',
};

const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

// Runs every vector check against the module `rc` and returns [{ name, ok, got }].
export async function checkVector(rc) {
  const v = VECTOR;
  const out = [];
  const check = (name, ok, got) => out.push({ name, ok: !!ok, got });
  const master = await rc.deriveMaster(v.passphrase, v.kdf);
  check('PBKDF2 master', hex(master) === v.master, hex(master));
  const keys = await rc.importKeys(master);
  const viaPass = await rc.deriveKeys('  Correct-Horse  battery staple ', v.kdf);
  const ref = await rc.refFor(keys, v.localId);
  check('HKDF + HMAC ref', ref === v.ref, ref);
  check('normalised passphrase gives the same keys', (await rc.refFor(viaPass, v.localId)) === v.ref);
  const header = { dir: 'down', kind: 'card', ref: v.ref, keyVersion: 1 };
  const row = await rc.encryptRow(keys, header, v.value, { iv: rc.fromB64(v.iv) });
  check('AES-GCM row body', row.iv === v.iv && row.body === v.body, row.body);
  const back = await rc.decryptRow(viaPass, { dir: 'down', kind: 'card', ref: v.ref, key_version: 1, iv: v.iv, body: v.body });
  check('row decrypts', JSON.stringify(back) === JSON.stringify(v.value), back);
  const ver = await rc.makeVerifier(keys, 1, { iv: rc.fromB64(v.iv) });
  check('verifier', ver === v.verifier, ver);
  check('verifier checks', await rc.checkVerifier(viaPass, v.verifier, 1));
  const blob = await rc.encryptBlob(keys, v.blobPath, new Uint8Array(v.blobPlain), { iv: rc.fromB64(v.iv) });
  check('blob', rc.toB64(blob) === v.blob, rc.toB64(blob));
  const plain = await rc.decryptBlob(viaPass, v.blobPath, rc.fromB64(v.blob));
  check('blob decrypts', hex(plain) === hex(new Uint8Array(v.blobPlain)), hex(plain));
  return out;
}
