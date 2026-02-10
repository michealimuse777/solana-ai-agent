import "./polyfills"; // MUST be first — sets up Buffer before Solana libs load
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair
} from "@solana/web3.js";
import {
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import bs58 from "bs58";
import { Buffer } from "buffer";
import * as Linking from "expo-linking";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, ScrollView, Text, TextInput, TouchableOpacity, View, StyleSheet, Alert } from "react-native";
import nacl from "tweetnacl";

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ─── CONFIG ─────────────────────────────────────────────────
const API_URL = "http://172.20.10.5:3000/agent/execute";
const SOLANA_RPC = "https://api.devnet.solana.com";
const connection = new Connection(SOLANA_RPC);

// Pre-build redirect URLs (must be created at module level)
const onConnectRedirectLink = Linking.createURL("onConnect");
const onSignTransactionRedirectLink = Linking.createURL("onSignTransaction");

// Use phantom:// for local dev (Expo Go). Set to true for production universal links.
const useUniversalLinks = false;
const buildUrl = (path, params) =>
  `${useUniversalLinks ? "https://phantom.app/ul/" : "phantom://"}v1/${path}?${params.toString()}`;

// ─── ENCRYPTION HELPERS ─────────────────────────────────────
const decryptPayload = (data, nonce, sharedSecret) => {
  if (!sharedSecret) throw new Error("missing shared secret");
  const decryptedData = nacl.box.open.after(
    bs58.decode(data),
    bs58.decode(nonce),
    sharedSecret
  );
  if (!decryptedData) throw new Error("Unable to decrypt data");
  return JSON.parse(Buffer.from(decryptedData).toString("utf8"));
};

const encryptPayload = (payload, sharedSecret) => {
  if (!sharedSecret) throw new Error("missing shared secret");
  const nonce = nacl.randomBytes(24);
  const encryptedPayload = nacl.box.after(
    Buffer.from(JSON.stringify(payload)),
    nonce,
    sharedSecret
  );
  return [nonce, encryptedPayload];
};

// ─── HELPER: SERIALIZE STRING ──────────────────────────────
const serializeString = (str) => {
  const buf = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
};

// ─── HELPER: CREATE METADATA INSTRUCTION ──────────────────
const createMetadataInstruction = (mint, payer, name, symbol, uri) => {
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );

  // Data: [discriminator(33), name, symbol, uri, sellerFee(u16), creators(opt), collection(opt), uses(opt), isMutable(bool), collectionDetails(opt)]
  // We mock the Borsh serialization for this specific instruction structure
  const discriminator = Buffer.from([33]); // CreateMetadataAccountV3

  const data = Buffer.concat([
    discriminator,
    serializeString(name),
    serializeString(symbol),
    serializeString(uri),
    Buffer.from([0, 0]), // sellerFeeBasisPoints = 0 (u16 LE)
    Buffer.from([0]),    // creators = null (Option<Vec>)
    Buffer.from([0]),    // collection = null (Option)
    Buffer.from([0]),    // uses = null (Option)
    Buffer.from([1]),    // isMutable = true
    Buffer.from([0]),    // collectionDetails = null (Option)
  ]);

  return {
    programId: METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false }, // Mint Authority
      { pubkey: payer, isSigner: true, isWritable: true },  // Payer
      { pubkey: payer, isSigner: false, isWritable: false },// Update Authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data,
  };
};

// ─── MAIN APP ───────────────────────────────────────────────
export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState(["> Ready. Connect wallet first."]);
  const [paymentSig, setPaymentSig] = useState(null);
  const [deepLink, setDeepLink] = useState("");
  const scrollViewRef = useRef(null);

  const addLog = useCallback((log) => setLogs((prev) => [...prev, "> " + log]), []);

  // Crypto state (persisted in memory for session)
  const [dappKeyPair] = useState(nacl.box.keyPair());
  const [sharedSecret, setSharedSecret] = useState(null);
  const [session, setSession] = useState(null);
  const [phantomWalletPublicKey, setPhantomWalletPublicKey] = useState(null);

  // ─── DEEP LINK LISTENER ─────────────────────────────────
  useEffect(() => {
    (async () => {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) setDeepLink(initialUrl);
    })();
    const subscription = Linking.addEventListener("url", ({ url }) => setDeepLink(url));
    return () => subscription.remove();
  }, []);

  // ─── HANDLE INBOUND DEEP LINKS ──────────────────────────
  useEffect(() => {
    if (!deepLink) return;

    const handleLink = async () => {
      const url = new URL(deepLink);
      const params = url.searchParams;

      // Check for errors
      if (params.get("errorCode")) {
        addLog(`⚠️ Error ${params.get("errorCode")}: ${params.get("errorMessage")}`);
        return;
      }

      // ── CONNECT RESPONSE ──
      if (/onConnect/.test(url.pathname || url.host)) {
        try {
          const sharedSecretDapp = nacl.box.before(
            bs58.decode(params.get("phantom_encryption_public_key")),
            dappKeyPair.secretKey
          );

          const connectData = decryptPayload(
            params.get("data"),
            params.get("nonce"),
            sharedSecretDapp
          );

          setSharedSecret(sharedSecretDapp);
          setSession(connectData.session);
          setPhantomWalletPublicKey(new PublicKey(connectData.public_key));

          addLog(`🟢 Connected: ${connectData.public_key.slice(0, 8)}...`);
        } catch (e) {
          addLog(`❌ Connect decrypt error: ${e.message}`);
        }
      }

      // ── SIGN TRANSACTION RESPONSE ──
      else if (/onSignTransaction/.test(url.pathname || url.host)) {
        try {
          const signData = decryptPayload(
            params.get("data"),
            params.get("nonce"),
            sharedSecret
          );

          // signData.transaction is the signed tx in base58
          addLog("📡 Sending signed transaction to network...");
          const signedTx = bs58.decode(signData.transaction);
          const sig = await connection.sendRawTransaction(signedTx);
          addLog(`✅ Transaction confirmed! Sig: ${sig.slice(0, 16)}...`);
        } catch (e) {
          addLog(`❌ Sign/Send error: ${e.message}`);
        }
      }
    };

    handleLink();
  }, [deepLink]);

  // ─── CONNECT TO PHANTOM ─────────────────────────────────
  const connectWallet = async () => {
    addLog("Opening Phantom...");
    const params = new URLSearchParams({
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      cluster: "devnet",
      app_url: "https://phantom.app",
      redirect_link: onConnectRedirectLink,
    });
    const url = buildUrl("connect", params);
    Linking.openURL(url);
  };

  // ─── SIGN TRANSACTION (Deep Link) ────────────────────────
  const signAndSendTx = async (txBase64, partialSigners = []) => {
    if (!session || !sharedSecret || !phantomWalletPublicKey) {
      addLog("⚠️ Connect wallet first!");
      return;
    }

    addLog("Building transaction for signing...");

    const txBuffer = Buffer.from(txBase64, "base64");
    const tx = Transaction.from(txBuffer);

    // Set recent blockhash and fee payer if not set (unlikely for builds, but safe)
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = phantomWalletPublicKey;

    // Partially sign if we have additional signers (e.g. Mint Keypair)
    if (partialSigners.length > 0) {
      tx.partialSign(...partialSigners);
      addLog(`🔐 Partially signed with ${partialSigners.length} keypair(s)`);
    }

    const serializedTx = tx.serialize({ requireAllSignatures: false });

    const payload = {
      session,
      transaction: bs58.encode(serializedTx),
    };

    const [nonce, encryptedPayload] = encryptPayload(payload, sharedSecret);

    const params = new URLSearchParams({
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      nonce: bs58.encode(nonce),
      redirect_link: onSignTransactionRedirectLink,
      payload: bs58.encode(encryptedPayload),
    });

    addLog("Opening Phantom to sign...");
    const url = buildUrl("signTransaction", params);
    Linking.openURL(url);
  };

  // ─── MINT NFT LOGIC ──────────────────────────────────────
  const mintNFT = async (name) => {
    addLog(`🎨 Preparing NFT Mint: "${name}"`);

    // 1. Generate Mint Keypair
    const mintKeypair = Keypair.generate();
    addLog(`🔑 Generated Mint: ${mintKeypair.publicKey.toBase58().slice(0, 8)}...`);

    // 2. Get Rent Exemptions
    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    // 3. User's ATA
    const userATA = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      phantomWalletPublicKey
    );

    // 4. Build Instructions
    const tx = new Transaction();

    // Create Account for Mint
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: phantomWalletPublicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      })
    );

    // Initialize Mint
    tx.add(
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        0, // decimals
        phantomWalletPublicKey, // mint authority
        phantomWalletPublicKey, // freeze authority
        TOKEN_PROGRAM_ID
      )
    );

    // Create ATA
    tx.add(
      createAssociatedTokenAccountInstruction(
        phantomWalletPublicKey, // payer
        userATA,
        phantomWalletPublicKey, // owner
        mintKeypair.publicKey,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Mint To
    tx.add(
      createMintToInstruction(
        mintKeypair.publicKey,
        userATA,
        phantomWalletPublicKey,
        1, // amount
        [],
        TOKEN_PROGRAM_ID
      )
    );

    // Create Metadata
    const metadataIx = createMetadataInstruction(
      mintKeypair.publicKey,
      phantomWalletPublicKey,
      name,
      "AI",
      "https://arweave.net/123" // Placeholder URI
    );
    tx.add(metadataIx);

    // 5. Serialize & Sign
    // We must serialize the transaction to base64 to pass it to our helper
    // But we need to attach the partial signer (mintKeypair) inside signAndSendTx
    // passing the Transaction object directly would be better, but our API uses base64
    // So let's serialize it *without* signatures first, then rebuild it?
    // Actually, `signAndSendTx` takes base64. 
    // We can serialize with `requireAllSignatures: false`.

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = phantomWalletPublicKey;

    // Serialize to base64 so we can reuse the generic flow
    const serialized = tx.serialize({ requireAllSignatures: false }).toString("base64");

    // Pass mintKeypair to be signed
    await signAndSendTx(serialized, [mintKeypair]);
  };

  // ─── MAIN HANDLER (AI Agent) ────────────────────────────
  const handleSend = async () => {
    try {
      const currentPubkey = phantomWalletPublicKey
        ? phantomWalletPublicKey.toBase58()
        : "11111111111111111111111111111111";

      addLog("Thinking...");

      const headers = { "Content-Type": "application/json" };
      if (paymentSig) headers["X-Payment-Sig"] = paymentSig;

      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, user_pubkey: currentPubkey }),
      });

      // ── x402 PAYWALL ──
      if (res.status === 402) {
        const payData = await res.json();
        addLog(`💰 Payment Required: ${payData.amount} lamports`);
        const fakeSig = "mock_devnet_signature";
        setPaymentSig(fakeSig);
        addLog("Mock payment set. Click Execute again.");
        return;
      }

      // ── PROCESS RESPONSE ──
      const data = await res.json();
      addLog(`AI: ${data.message} [${data.action_type}]`);

      // SWAP or TRANSFER → sign with wallet
      if (data.tx_base64) {
        if (phantomWalletPublicKey) {
          await signAndSendTx(data.tx_base64);
        } else {
          addLog("📋 Tx ready but no wallet. Connect first!");
          addLog(`base64: ${data.tx_base64.slice(0, 30)}...`);
        }
      }

      // MINT NFT
      else if (data.action_type === "MINT_NFT") {
        const name = data.meta?.name || "AI Artwork";
        await mintNFT(name);
      }
    } catch (e) {
      addLog(`❌ Error: ${e.message}`);
    }
  };

  // ─── PREMIUM PURPLE CRYPTO UI ──────────────────────────────
  const isConnected = !!phantomWalletPublicKey;
  const walletShort = isConnected
    ? `${phantomWalletPublicKey.toBase58().slice(0, 6)}...${phantomWalletPublicKey.toBase58().slice(-4)}`
    : null;

  return (
    <View style={s.container}>
      {/* ── HEADER CARD ── */}
      <View style={s.headerCard}>
        <Text style={s.logo}>⚡ SOLANA AI AGENT</Text>
        <Text style={s.tagline}>Powered by Gemini · On-Chain Intelligence</Text>

        {/* Wallet Status Pill */}
        <View style={[s.statusPill, isConnected ? s.statusConnected : s.statusDisconnected]}>
          <Text style={s.statusDot}>{isConnected ? "●" : "○"}</Text>
          <Text style={s.statusText}>
            {isConnected ? walletShort : "No Wallet"}
          </Text>
        </View>
      </View>

      {/* ── CONNECT BUTTON ── */}
      <TouchableOpacity
        style={[s.btn, isConnected ? s.btnConnected : s.btnPrimary]}
        onPress={connectWallet}
        activeOpacity={0.8}
      >
        <Text style={s.btnText}>
          {isConnected ? "✓ CONNECTED" : "⚡ CONNECT PHANTOM"}
        </Text>
      </TouchableOpacity>

      {/* ── INPUT AREA ── */}
      <View style={s.inputCard}>
        <Text style={s.inputLabel}>COMMAND</Text>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder='Try: "Swap 0.1 SOL to USDC"'
          placeholderTextColor="#6b5b95"
          style={s.input}
          multiline={false}
        />
        <TouchableOpacity
          style={s.executeBtn}
          onPress={handleSend}
          activeOpacity={0.7}
        >
          <Text style={s.executeBtnText}>EXECUTE ▸</Text>
        </TouchableOpacity>
      </View>

      {/* ── ACTIVITY LOG ── */}
      <View style={s.logCard}>
        <View style={s.logHeader}>
          <Text style={s.logTitle}>ACTIVITY LOG</Text>
          <Text style={s.logBadge}>{logs.length}</Text>
        </View>
        <ScrollView
          style={s.logScroll}
          ref={scrollViewRef}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
          showsVerticalScrollIndicator={false}
        >
          {logs.map((log, i) => {
            const isError = log.includes("❌") || log.includes("Error");
            const isSuccess = log.includes("✅") || log.includes("🟢");
            const isWarning = log.includes("⚠️") || log.includes("💰");
            const isMint = log.includes("🎨") || log.includes("🔑");
            const isSystem = log.includes("📡") || log.includes("🔐");

            const color = isError ? "#ff4d6a"
              : isSuccess ? "#00e676"
                : isWarning ? "#ffab40"
                  : isMint ? "#e040fb"
                    : isSystem ? "#7c4dff"
                      : "#9e9eb8";

            return (
              <Text key={`log-${i}`} style={[s.logText, { color }]}>
                {log}
              </Text>
            );
          })}
        </ScrollView>
      </View>

      {/* ── FOOTER ── */}
      <Text style={s.footer}>DEVNET · v2.0 · {new Date().getFullYear()}</Text>
    </View>
  );
}

// ─── PREMIUM PURPLE CRYPTO STYLES ───────────────────────────
const s = StyleSheet.create({
  // ── Layout ──
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 64,
    paddingBottom: 20,
    backgroundColor: "#0a0a1a",
  },

  // ── Header Card ──
  headerCard: {
    backgroundColor: "#12122a",
    borderRadius: 20,
    padding: 24,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#2a1f5e",
    shadowColor: "#7c3aed",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  logo: {
    fontSize: 24,
    fontWeight: "900",
    color: "#e0d4ff",
    letterSpacing: 2,
    marginBottom: 4,
  },
  tagline: {
    fontSize: 12,
    color: "#7c6baa",
    letterSpacing: 0.5,
    marginBottom: 16,
  },

  // ── Status Pill ──
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusConnected: {
    backgroundColor: "rgba(0, 230, 118, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(0, 230, 118, 0.3)",
  },
  statusDisconnected: {
    backgroundColor: "rgba(255, 77, 106, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 77, 106, 0.3)",
  },
  statusDot: {
    fontSize: 10,
    marginRight: 8,
    color: "#00e676",
  },
  statusText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#c8b8e8",
    fontFamily: "Courier New",
  },

  // ── Buttons ──
  btn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  btnPrimary: {
    backgroundColor: "#7c3aed",
    shadowColor: "#7c3aed",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 6,
  },
  btnConnected: {
    backgroundColor: "#1a2f1a",
    borderWidth: 1,
    borderColor: "#2e7d32",
  },
  btnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 1.5,
  },

  // ── Input Card ──
  inputCard: {
    backgroundColor: "#12122a",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#2a1f5e",
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#7c6baa",
    letterSpacing: 2,
    marginBottom: 10,
  },
  input: {
    backgroundColor: "#0d0d20",
    borderWidth: 1,
    borderColor: "#3a2e6e",
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: "#e0d4ff",
    marginBottom: 12,
  },
  executeBtn: {
    backgroundColor: "#9333ea",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    shadowColor: "#9333ea",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  executeBtnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 1.5,
  },

  // ── Log Card ──
  logCard: {
    flex: 1,
    backgroundColor: "#0d0d20",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1f1a3e",
  },
  logHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  logTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#7c6baa",
    letterSpacing: 2,
  },
  logBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: "#9333ea",
    backgroundColor: "rgba(147, 51, 234, 0.15)",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: "hidden",
  },
  logScroll: {
    flex: 1,
  },
  logText: {
    fontFamily: "Courier New",
    fontSize: 12,
    lineHeight: 20,
    marginBottom: 2,
  },

  // ── Footer ──
  footer: {
    textAlign: "center",
    fontSize: 10,
    color: "#3a3a5c",
    marginTop: 12,
    letterSpacing: 2,
    fontWeight: "600",
  },
});
