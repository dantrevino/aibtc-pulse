import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import {
  p2wpkh,
  Script,
  RawTx,
  RawWitness,
  Transaction,
  NETWORK as BTC_MAINNET,
  TEST_NETWORK as BTC_TESTNET,
} from "@scure/btc-signer";
import { hashSha256Sync } from "@stacks/encryption";

const AIBTC_DIR = path.join(process.env.HOME, ".aibtc");

export async function decryptKeystore(password) {
  const config = JSON.parse(fs.readFileSync(path.join(AIBTC_DIR, "config.json"), "utf8"));
  const walletId = process.env.WALLET_ID || config.activeWalletId;
  const keystorePath = path.join(AIBTC_DIR, "wallets", walletId, "keystore.json");
  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf8"));

  const ciphertext = Buffer.from(keystore.encrypted.ciphertext, "base64");
  const iv = Buffer.from(keystore.encrypted.iv, "base64");
  const authTag = Buffer.from(keystore.encrypted.authTag, "base64");
  const salt = Buffer.from(keystore.encrypted.salt, "base64");

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keystore.encrypted.scryptParams.keyLen, {
      N: keystore.encrypted.scryptParams.N,
      r: keystore.encrypted.scryptParams.r,
      p: keystore.encrypted.scryptParams.p,
    }, (err, key) => {
      if (err) { reject(err); return; }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      try {
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        resolve(decrypted.toString("utf8"));
      } catch (e) {
        reject(new Error("Decryption failed — invalid password"));
      }
    });
  });
}

export function deriveBtcKeyPair(mnemonic, network = "mainnet") {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const coinType = network === "mainnet" ? 0 : 1;
  const derived = master.derive(`m/84'/${coinType}'/0'/0/0`);
  const btcNet = network === "testnet" ? BTC_TESTNET : BTC_MAINNET;
  const addr = p2wpkh(derived.publicKey, btcNet);
  return {
    address: addr.address,
    privateKey: new Uint8Array(derived.privateKey),
    publicKey: new Uint8Array(derived.publicKey),
  };
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { result.set(a, off); off += a.length; }
  return result;
}

function bip322TaggedHash(message) {
  const tagBytes = new TextEncoder().encode("BIP0322-signed-message");
  const tagHash = hashSha256Sync(tagBytes);
  const msgBytes = new TextEncoder().encode(message);
  return hashSha256Sync(concatBytes(tagHash, tagHash, msgBytes));
}

function doubleSha256(data) {
  return hashSha256Sync(hashSha256Sync(data));
}

function bip322BuildToSpendTxId(message, scriptPubKey) {
  const msgHash = bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  const rawTx = RawTx.encode({
    version: 0,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 }],
    outputs: [{ amount: 0n, script: scriptPubKey }],
    lockTime: 0,
  });
  return doubleSha256(rawTx).reverse();
}

export function bip322Sign(message, privateKey, publicKey) {
  const btcNet = process.env.NETWORK === "testnet" ? BTC_TESTNET : BTC_MAINNET;
  const addr = p2wpkh(publicKey, btcNet);
  const scriptPubKey = addr.script;

  const msgHash = bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);

  const toSignTx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  toSignTx.addInput({
    txid: toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { amount: 0n, script: scriptPubKey },
  });
  toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });
  toSignTx.signIdx(privateKey, 0);
  toSignTx.finalizeIdx(0);
  const input = toSignTx.getInput(0);
  if (!input.finalScriptWitness) throw new Error("BIP-322 signing failed: no witness");
  return Buffer.from(RawWitness.encode(input.finalScriptWitness)).toString("base64");
}

export function run(cmd, opts = {}) {
  const verbose = process.env.VERBOSE === "1";
  const timeout = opts.timeout || 30000;

  if (verbose) {
    console.error(`[VERBOSE] CMD: ${cmd.slice(0, 200)}${cmd.length > 200 ? "..." : ""}`);
  }

  try {
    const result = execSync(cmd, {
      encoding: "utf8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    if (verbose) {
      console.error(`[VERBOSE] OUT: ${result.trim().slice(0, 200)}${result.trim().length > 200 ? "..." : ""}`);
    }
    return { stdout: result.trim(), stderr: "", code: 0 };
  } catch (e) {
    if (e.stdout) {
      if (verbose) {
        console.error(`[VERBOSE] ERR: ${e.stderr?.toString().slice(0, 200)}${e.stderr?.toString().length > 200 ? "..." : ""}`);
      }
      return { stdout: e.stdout.toString().trim(), stderr: e.stderr?.toString() || "", code: e.status || 1 };
    }
    if (verbose) {
      console.error(`[VERBOSE] FAIL: ${e.message.slice(0, 200)}`);
    }
    return { stdout: "", stderr: e.message, code: e.status || 1 };
  }
}

export function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}