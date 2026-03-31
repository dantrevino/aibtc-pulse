/**
 * Wallet module — manages agent wallet session, key derivation, and transaction signing.
 *
 * Design principles:
 * - Addresses are PUBLIC — read from wallets.json without decryption
 * - Mnemonic and private keys are SENSITIVE — stay encrypted until unlock
 * - Decrypted keys live in memory only while unlocked, auto-lock after timeout
 * - Signing operations require unlocked wallet
 *
 * Storage (~/.aibtc/):
 *   config.json      — activeWalletId, autoLockTimeout
 *   wallets.json     — wallet metadata (name, addresses, network) — NO decryption needed
 *   wallets/{id}/keystore.json — encrypted mnemonic (AES-256-GCM + scrypt)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import {
  p2wpkh,
  p2tr,
  Script,
  RawTx,
  RawWitness,
  Transaction,
  NETWORK as BTC_MAINNET,
  TEST_NETWORK as BTC_TESTNET,
} from "@scure/btc-signer";
import {
  SbtcApiClientMainnet,
  SbtcApiClientTestnet,
  buildSbtcDepositAddress,
  sbtcDepositHelper,
  MAINNET as SBTC_MAINNET,
  TESTNET as SBTC_TESTNET,
} from "sbtc";
import StacksWalletSdk from "@stacks/wallet-sdk";
const { generateWallet, getStxAddress, generateSecretKey, validateMnemonic } = StacksWalletSdk;
import StacksTransactions from "@stacks/transactions";
const {
  makeSTXTokenTransfer,
  makeContractCall,
  uintCV,
  principalCV,
  noneCV,
  PostConditionMode,
  serializeCV,
} = StacksTransactions;
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import { hashSha256Sync } from "@stacks/encryption";

const AIBTC_DIR = path.join(process.env.HOME, ".aibtc");
const CONFIG_PATH = path.join(AIBTC_DIR, "config.json");
const WALLETS_PATH = path.join(AIBTC_DIR, "wallets.json");
const NETWORK = process.env.NETWORK || "mainnet";
const HIRO_API_MAINNET = "https://api.hiro.so";
const HIRO_API_TESTNET = "https://api.testnet.hiro.so";

const SBTC_CONTRACTS = {
  mainnet: "SP3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NZ159.sbtc-token",
  testnet: "ST3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NBZKM.sbtc-token",
};

const SBTC_REGISTRY_CONTRACTS = {
  mainnet: "SP3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NZ159.sbtc-registry",
  testnet: "ST3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NBZKM.sbtc-registry",
};

function getHiroApiUrl() {
  return NETWORK === "testnet" ? HIRO_API_TESTNET : HIRO_API_MAINNET;
}

function getBtcNetwork() {
  return NETWORK === "testnet" ? BTC_TESTNET : BTC_MAINNET;
}

function getStacksNetwork() {
  return NETWORK === "testnet" ? STACKS_TESTNET : STACKS_MAINNET;
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

function bip322Sign(message, privateKey, publicKey) {
  const btcNet = getBtcNetwork();
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

// ============================================================================
// WalletConfig — public info only, no decryption needed
// ============================================================================

export class WalletConfig {
  #data;

  constructor(data) {
    this.#data = data;
  }

  get walletId() { return this.#data.id; }
  get name() { return this.#data.name; }
  get stxAddress() { return this.#data.address; }
  get btcAddress() { return this.#data.btcAddress; }
  get taprootAddress() { return this.#data.taprootAddress; }
  get network() { return this.#data.network; }

  static load(walletId = null) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
    const activeId = walletId || config.activeWalletId;
    const wallet = wallets.wallets.find(w => w.id === activeId);
    if (!wallet) throw new Error(`Wallet not found: ${activeId}`);
    return new WalletConfig(wallet);
  }

  static exists() {
    return fs.existsSync(CONFIG_PATH) && fs.existsSync(WALLETS_PATH);
  }
}

// ============================================================================
// Keystore operations
// ============================================================================

async function decryptKeystoreFile(walletId, password) {
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

function encryptMnemonic(mnemonic, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, {
      N: 16384,
      r: 8,
      p: 1,
      keyLen: 32,
    }, (err, key) => {
      if (err) { reject(err); return; }
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      resolve({
        ciphertext: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        salt: salt.toString("base64"),
        scryptParams: { N: 16384, r: 8, p: 1, keyLen: 32 },
      });
    });
  });
}

function deriveBtcKeyPair(mnemonic, network = NETWORK) {
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

function deriveTaprootKeyPair(mnemonic, network = NETWORK) {
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const coinType = network === "mainnet" ? 0 : 1;
  const derived = master.derive(`m/86'/${coinType}'/0'/0/0`);
  const btcNet = network === "testnet" ? BTC_TESTNET : BTC_MAINNET;
  const xOnlyPubkey = derived.publicKey.slice(1, 33);
  const addr = p2tr(xOnlyPubkey, undefined, btcNet);
  return {
    address: addr.address,
    privateKey: new Uint8Array(derived.privateKey),
    publicKey: new Uint8Array(xOnlyPubkey),
  };
}

async function deriveStxKeyPair(mnemonic) {
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0];
  const stacksNet = getStacksNetwork();
  const address = getStxAddress({ account, transactionVersion: stacksNet.version });
  return { address, privateKey: account.stxPrivateKey };
}

// ============================================================================
// WalletManager singleton — manages lock/unlock state
// ============================================================================

let _manager = null;

class WalletManager {
  #config;
  #mnemonic = null;
  #btcKeyPair = null;
  #taprootKeyPair = null;
  #stxKeyPair = null;
  #lockTimer = null;
  #autoLockMinutes = 60;

  constructor(config) {
    this.#config = config;
  }

  get stxAddress() { return this.#config.stxAddress; }
  get btcAddress() { return this.#config.btcAddress; }
  get taprootAddress() { return this.#config.taprootAddress; }
  get network() { return this.#config.network; }
  get isLocked() { return this.#mnemonic === null; }

  async unlock(password) {
    if (!this.isLocked) return;

    const mnemonic = await decryptKeystoreFile(this.#config.walletId, password);
    this.#mnemonic = mnemonic;
    this.#btcKeyPair = deriveBtcKeyPair(mnemonic);
    this.#taprootKeyPair = deriveTaprootKeyPair(mnemonic);
    this.#stxKeyPair = await deriveStxKeyPair(mnemonic);

    if (this.#autoLockMinutes > 0) {
      this.#lockTimer = setTimeout(() => this.lock(), this.#autoLockMinutes * 60 * 1000);
    }
  }

  lock() {
    if (this.#lockTimer) {
      clearTimeout(this.#lockTimer);
      this.#lockTimer = null;
    }
    if (this.#mnemonic) {
      this.#mnemonic = null;
    }
    this.#btcKeyPair = null;
    this.#taprootKeyPair = null;
    this.#stxKeyPair = null;
  }

  setAutoLockMinutes(minutes) {
    this.#autoLockMinutes = minutes;
    if (!this.isLocked && minutes > 0) {
      if (this.#lockTimer) clearTimeout(this.#lockTimer);
      this.#lockTimer = setTimeout(() => this.lock(), minutes * 60 * 1000);
    } else if (minutes <= 0 && this.#lockTimer) {
      clearTimeout(this.#lockTimer);
      this.#lockTimer = null;
    }
  }

  btcSign(message) {
    if (this.isLocked) throw new Error("Wallet is locked");
    return bip322Sign(message, this.#btcKeyPair.privateKey, this.#btcKeyPair.publicKey);
  }

  getBtcKeyPair() {
    if (this.isLocked) throw new Error("Wallet is locked");
    return this.#btcKeyPair;
  }

  getTaprootKeyPair() {
    if (this.isLocked) throw new Error("Wallet is locked");
    return this.#taprootKeyPair;
  }

  async signStxTransfer(recipient, amountMicroStx, memo = "") {
    if (this.isLocked) throw new Error("Wallet is locked");
    const wallet = await generateWallet({ secretKey: this.#mnemonic, password: "" });
    const account = wallet.accounts[0];
    const stacksNet = getStacksNetwork();
    const tx = await makeSTXTokenTransfer({
      recipient,
      amount: BigInt(amountMicroStx),
      senderKey: account.stxPrivateKey,
      network: stacksNet,
      memo,
      sponsored: false,
      fee: 0n,
    });
    return "0x" + tx.serialize().toString("hex");
  }

  async signSbtcTransfer(recipient, amountSats) {
    if (this.isLocked) throw new Error("Wallet is locked");
    const wallet = await generateWallet({ secretKey: this.#mnemonic, password: "" });
    const account = wallet.accounts[0];
    const stacksNet = getStacksNetwork();
    const contractId = SBTC_CONTRACTS[NETWORK];
    const [contractAddress, contractName] = contractId.split(".");
    const tx = await makeContractCall({
      contractAddress,
      contractName,
      functionName: "transfer",
      functionArgs: [
        uintCV(BigInt(amountSats)),
        principalCV(account.address),
        principalCV(recipient),
        noneCV(),
      ],
      senderKey: account.stxPrivateKey,
      network: stacksNet,
      postConditionMode: PostConditionMode.Allow,
      sponsored: false,
      fee: 0n,
    });
    return "0x" + tx.serialize().toString("hex");
  }
}

export function getWalletManager(config = null) {
  if (!_manager) {
    if (!config) config = WalletConfig.load();
    _manager = new WalletManager(config);
  }
  return _manager;
}

export function resetWalletManager() {
  if (_manager) _manager.lock();
  _manager = null;
}

// ============================================================================
// Setup — interactive wallet creation/import
// ============================================================================

function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function prompt(question) {
  return new Promise(resolve => {
    const rl = createRl();
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

function confirm(question) {
  return new Promise(resolve => {
    const rl = createRl();
    rl.question(question + " (y/n): ", answer => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

async function setupWallet() {
  console.log("\n=== Wallet Setup ===\n");

  if (WalletConfig.exists()) {
    const config = WalletConfig.load();
    console.log(`Found existing wallet: ${config.name}`);
    console.log(`  STX:      ${config.stxAddress}`);
    console.log(`  BTC:      ${config.btcAddress}`);
    console.log(`  Taproot:  ${config.taprootAddress}`);
    console.log(`  Network:  ${config.network}\n`);

    const overwrite = await confirm("Overwrite existing wallet?");
    if (!overwrite) {
      console.log("Setup cancelled.");
      return;
    }
  }

  const choice = await prompt("Create new wallet (1) or import existing mnemonic (2)? ");
  let mnemonic;

  if (choice.trim() === "2") {
    mnemonic = await prompt("Enter your 24-word mnemonic: ");
    mnemonic = mnemonic.trim().toLowerCase();
    if (!validateMnemonic(mnemonic)) {
      throw new Error("Invalid mnemonic phrase");
    }
  } else {
    mnemonic = generateSecretKey();
    console.log(`\nGenerated new mnemonic (SAVE THIS!):`);
    console.log(`  ${mnemonic}\n`);
    const saved = await confirm("Have you saved your mnemonic?");
    if (!saved) {
      console.log("Please save your mnemonic and run setup again.");
      return;
    }
  }

  const password = await prompt("Enter wallet password (for encryption): ");
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const network = NETWORK;
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0];
  const stacksNet = getStacksNetwork();
  const stxAddress = getStxAddress({ account, transactionVersion: stacksNet.version });
  const btcKeyPair = deriveBtcKeyPair(mnemonic, network);
  const taprootKeyPair = deriveTaprootKeyPair(mnemonic, network);

  const walletId = crypto.randomUUID();
  const walletDir = path.join(AIBTC_DIR, "wallets", walletId);
  fs.mkdirSync(walletDir, { recursive: true });

  const encrypted = await encryptMnemonic(mnemonic, password);
  const keystore = { version: 1, encrypted };
  fs.writeFileSync(path.join(walletDir, "keystore.json"), JSON.stringify(keystore, null, 2));

  const configData = {
    version: 1,
    activeWalletId: walletId,
    autoLockTimeout: 60,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configData, null, 2));

  const walletsData = {
    version: 1,
    wallets: [{
      id: walletId,
      name: "Agent Wallet",
      address: stxAddress,
      btcAddress: btcKeyPair.address,
      taprootAddress: taprootKeyPair.address,
      network,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    }],
  };
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(walletsData, null, 2));

  console.log(`\nWallet created successfully!`);
  console.log(`  Wallet ID: ${walletId}`);
  console.log(`  STX:       ${stxAddress}`);
  console.log(`  BTC:       ${btcKeyPair.address}`);
  console.log(`  Taproot:   ${taprootKeyPair.address}\n`);
  console.log(`Next: Update CLAUDE.md and AGENTS.md with these addresses, then run the loop.`);
}

// ============================================================================
// Balance & broadcast helpers
// ============================================================================

export async function getStxBalance(address) {
  const apiUrl = getHiroApiUrl();
  const response = await fetch(`${apiUrl}/extended/v1/address/${address}/stx`);
  if (!response.ok) throw new Error(`Hiro API error: ${response.status}`);
  const data = await response.json();
  return {
    balance: (BigInt(data.balance) / 1000000n).toString(),
    locked: (BigInt(data.locked) / 1000000n).toString(),
    balanceMicro: data.balance,
    lockedMicro: data.locked,
  };
}

export async function getBtcBalance(address) {
  const mempoolUrl = NETWORK === "testnet"
    ? "https://mempool.space/testnet/api"
    : "https://mempool.space/api";

  const response = await fetch(`${mempoolUrl}/address/${address}/utxo`);
  if (!response.ok) throw new Error(`Mempool API error: ${response.status}`);
  const utxos = await response.json();

  let total = 0n;
  for (const utxo of utxos) {
    total += BigInt(utxo.value);
  }
  return { total: total.toString(), utxos };
}

export async function getSbtcBalance(address) {
  const url = `${getHiroApiUrl()}/extended/v1/address/${address}/balances`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Hiro API error: ${response.status}`);
  const data = await response.json();

  const sbtcKey = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";
  if (data.fungible_tokens && data.fungible_tokens[sbtcKey]) {
    return data.fungible_tokens[sbtcKey].balance;
  }
  return "0";
}

export async function broadcastTransaction(txHex) {
  const apiUrl = getHiroApiUrl();
  const response = await fetch(`${apiUrl}/v2/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: txHex.replace(/^0x/, ""),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Broadcast failed: ${response.status} - ${errorText}`);
  }
  const txid = await response.text();
  return txid.replace(/"/g, "");
}

// ============================================================================
// BTC on-chain sending
// ============================================================================

async function getBtcUtxos(address) {
  const mempoolUrl = NETWORK === "testnet"
    ? "https://mempool.space/testnet/api"
    : "https://mempool.space/api";

  const response = await fetch(`${mempoolUrl}/address/${address}/utxo`);
  if (!response.ok) throw new Error(`Mempool API error: ${response.status}`);
  return response.json();
}

export async function sendBtc(privateKey, publicKey, toAddress, sats) {
  const btcNet = getBtcNetwork();
  const utxos = await getBtcUtxos(p2wpkh(publicKey, btcNet).address);

  if (utxos.length === 0) throw new Error("No UTXOs found");

  const feeRateResponse = await fetch(
    `${NETWORK === "testnet" ? "https://mempool.space/testnet/api" : "https://mempool.space/api"}/v1/fees/recommended`
  );
  const feeRates = await feeRateResponse.json();
  const satsPerVbyte = feeRates.hourFee ?? 1;



  const tx = new Transaction({ allowUnknownOutputs: true });

  let totalSats = 0n;
  for (const utxo of utxos) {
    const utxoTxResponse = await fetch(
      `${NETWORK === "testnet" ? "https://mempool.space/testnet/api" : "https://mempool.space/api"}/tx/${utxo.txid}`
    );
    const utxoTx = await utxoTxResponse.json();
    const vout = utxoTx.vout[utxo.vout];
    const script = Buffer.from(vout.scriptpubkey, "hex");

    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { amount: BigInt(vout.value), script },
    });
    totalSats += BigInt(vout.value);
  }

  const fee = BigInt(Math.ceil((Buffer.from(tx.hex, 'hex').length / 2) * satsPerVbyte));
  const sendAmount = BigInt(sats);

  if (totalSats < sendAmount + fee) {
    throw new Error(`Insufficient funds: have ${totalSats}, need ${sendAmount + fee}`);
  }

  tx.addOutputAddress(toAddress, sendAmount);
  tx.addOutput({ script: p2wpkh(publicKey, btcNet).script, amount: totalSats - sendAmount - fee });

  tx.sign(privateKey);
  tx.finalize();

  const txHex = tx.hex;

  const broadcastResponse = await fetch(
    `${NETWORK === "testnet" ? "https://mempool.space/testnet/api" : "https://mempool.space/api"}/tx`,
    { method: "POST", body: txHex }
  );

  if (!broadcastResponse.ok) {
    const err = await broadcastResponse.text();
    throw new Error(`Broadcast failed: ${broadcastResponse.status} - ${err}`);
  }

  return broadcastResponse.text();
}

// ============================================================================
// sBTC Deposit
// ============================================================================

function getSbtcApiClient() {
  return NETWORK === "testnet" ? new SbtcApiClientTestnet() : new SbtcApiClientMainnet();
}

function getSbtcBitcoinNetwork() {
  return NETWORK === "testnet" ? SBTC_TESTNET : SBTC_MAINNET;
}

async function getSignersPublicKey() {
  const apiClient = getSbtcApiClient();
  const registryContract = SBTC_REGISTRY_CONTRACTS[NETWORK];
  const [address] = registryContract.split(".");
  return await apiClient.fetchSignersPublicKey(address);
}

async function sbtcDeposit(amountSats, feeRate, options = {}) {
  const {
    maxSignerFee = 80000,
    reclaimLockTime = 950,
    includeOrdinals = false,
  } = options;

  const wallet = getWalletManager();
  if (wallet.isLocked) throw new Error("Wallet is locked");

  const btcKeyPair = wallet.getBtcKeyPair();
  const taprootKeyPair = wallet.getTaprootKeyPair();

  if (!taprootKeyPair) throw new Error("Taproot key pair not available");

  const apiClient = getSbtcApiClient();
  const btcNet = getBtcNetwork();
  const sbtcNet = getSbtcBitcoinNetwork();
  const mempoolUrl = NETWORK === "testnet"
    ? "https://mempool.space/testnet/api"
    : "https://mempool.space/api";

  const utxos = await fetch(`${mempoolUrl}/address/${btcKeyPair.address}/utxo`).then(r => r.json());

  if (utxos.length === 0) throw new Error("No UTXOs found");

  const utxosWithTx = await Promise.all(
    utxos.map(async (utxo) => {
      const txResp = await fetch(`${mempoolUrl}/tx/${utxo.txid}`);
      const tx = await txResp.json();
      return {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: {
          confirmed: utxo.status.confirmed,
          block_height: utxo.status.block_height ?? 0,
        },
        tx: tx.hex,
      };
    })
  );

  const signersPublicKey = await getSignersPublicKey();
  const reclaimPublicKey = Buffer.from(taprootKeyPair.publicKey).toString("hex");

  const depositResult = await sbtcDepositHelper({
    network: sbtcNet,
    amountSats,
    stacksAddress: wallet.stxAddress,
    bitcoinChangeAddress: btcKeyPair.address,
    signersPublicKey,
    reclaimPublicKey,
    feeRate,
    utxos: utxosWithTx,
    maxSignerFee,
    reclaimLockTime,
  });

  depositResult.transaction.sign(taprootKeyPair.privateKey);
  depositResult.transaction.finalize();

  const txHex = depositResult.transaction.hex;

  const broadcastResp = await fetch(`${mempoolUrl}/tx`, {
    method: "POST",
    body: txHex,
  });

  if (!broadcastResp.ok) {
    const err = await broadcastResp.text();
    throw new Error(`Broadcast failed: ${broadcastResp.status} - ${err}`);
  }

  const txid = await broadcastResp.text();

  const notification = await apiClient.notifySbtc({
    depositScript: depositResult.depositScript,
    reclaimScript: depositResult.reclaimScript,
    vout: 0,
    transaction: txHex,
  });

  return { txid, notification };
}

// ============================================================================
// CLI
// ============================================================================

function printUsage() {
  console.log(`
Wallet CLI — usage:

  node scripts/wallet.mjs setup                   Interactive wallet setup
  node scripts/wallet.mjs balances                Show all balances (STX, sBTC)
  node scripts/wallet.mjs info                    Show wallet addresses
  node scripts/wallet.mjs send-btc <addr> <sats> Send BTC on-chain
  node scripts/wallet.mjs send-sbtc <addr> <sats> Send sBTC
  node scripts/wallet.mjs sbtc-deposit <sats> <fee-rate> Deposit BTC for sBTC
  node scripts/wallet.mjs lock                   Lock the wallet

Environment:
  WALLET_PASSWORD  Wallet password (required for send/lock)
  NETWORK         mainnet (default) | testnet
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help") {
    printUsage();
    return;
  }

  try {
    if (cmd === "setup") {
      await setupWallet();
      return;
    }

    if (!WalletConfig.exists()) {
      console.error("No wallet found. Run 'node scripts/wallet.mjs setup' first.");
      process.exit(1);
    }

    const config = WalletConfig.load();
    const wallet = getWalletManager(config);

    if (cmd === "info") {
      console.log(`Wallet: ${config.name}`);
      console.log(`STX:      ${config.stxAddress}`);
      console.log(`BTC:      ${config.btcAddress}`);
      console.log(`Taproot:  ${config.taprootAddress}`);
      console.log(`Network:  ${config.network}`);
      console.log(`Status:   ${wallet.isLocked ? "LOCKED" : "UNLOCKED"}`);
      return;
    }

    if (cmd === "balances") {
      console.log(`STX:  ${config.stxAddress}`);
      const stxBal = await getStxBalance(config.stxAddress);
      console.log(`  Balance: ${stxBal.balance} STX`);
      if (stxBal.locked !== "0") console.log(`  Locked:  ${stxBal.locked} STX`);
      console.log(`sBTC: ${config.stxAddress}`);
      const sbtcBal = await getSbtcBalance(config.stxAddress);
      console.log(`  Balance: ${sbtcBal} sBTC`);
      console.log(`BTC:  ${config.btcAddress}`);
      const btcBal = await getBtcBalance(config.btcAddress);
      console.log(`  Balance: ${btcBal.total} sats (${(btcBal.total / 100000000).toFixed(8)} BTC)`);
      return;
    }

    if (cmd === "send-btc") {
      const password = process.env.WALLET_PASSWORD;
      if (!password) {
        console.error("WALLET_PASSWORD required for sending");
        process.exit(1);
      }
      const [toAddr, satsStr] = args.slice(1);
      if (!toAddr || !satsStr) {
        console.error("Usage: node scripts/wallet.mjs send-btc <address> <sats>");
        process.exit(1);
      }
      const sats = parseInt(satsStr, 10);
      if (isNaN(sats) || sats <= 0) {
        console.error("Invalid sats amount");
        process.exit(1);
      }

      await wallet.unlock(password);
      const kp = wallet.getBtcKeyPair();
      console.log(`Sending ${sats} sats from ${kp.address} to ${toAddr}...`);

      const txid = await sendBtc(kp.privateKey, kp.publicKey, toAddr, sats);
      console.log(`Broadcasted: ${txid}`);
      wallet.lock();
      return;
    }

    if (cmd === "sbtc-deposit") {
      const password = process.env.WALLET_PASSWORD;
      if (!password) {
        console.error("WALLET_PASSWORD required for sBTC deposit");
        process.exit(1);
      }
      const [satsStr, feeRateStr] = args.slice(1);
      if (!satsStr || !feeRateStr) {
        console.error("Usage: node scripts/wallet.mjs sbtc-deposit <sats> <fee-rate>");
        process.exit(1);
      }
      const sats = parseInt(satsStr, 10);
      const feeRate = parseInt(feeRateStr, 10);
      if (isNaN(sats) || sats <= 0 || isNaN(feeRate) || feeRate <= 0) {
        console.error("Invalid amount or fee rate");
        process.exit(1);
      }

      await wallet.unlock(password);
      console.log(`Depositing ${sats} sats BTC for sBTC...`);
      console.log(`STX address: ${config.stxAddress}`);
      console.log(`BTC address: ${config.btcAddress}`);

      const result = await sbtcDeposit(sats, feeRate);
      console.log(`Broadcasted: ${result.txid}`);
      wallet.lock();
      return;
    }

    console.error(`Unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Only run main if executed directly
if (process.argv[1]?.endsWith('wallet.mjs')) main();
