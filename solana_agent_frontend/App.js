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
import { Button, ScrollView, Text, TextInput, View, StyleSheet, Alert } from "react-native";
import nacl from "tweetnacl";

global.Buffer = global.Buffer || Buffer;

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

  // ─── UI ───────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* Header */}
      <Text style={styles.title}>Solana AI Agent</Text>
      <Text style={styles.subtitle}>
        {phantomWalletPublicKey
          ? `🟢 ${phantomWalletPublicKey.toBase58().slice(0, 8)}...${phantomWalletPublicKey.toBase58().slice(-4)}`
          : "🔴 No Wallet"}
        {"  "}| Target: {API_URL.replace("http://", "")}
      </Text>

      {/* Buttons */}
      <View style={styles.buttonRow}>
        <View style={styles.btnWrap}>
          <Button
            title={phantomWalletPublicKey ? "✅ Connected" : "Connect Wallet"}
            onPress={connectWallet}
            color={phantomWalletPublicKey ? "#4CAF50" : "#2196F3"}
          />
        </View>
      </View>

      {/* Input */}
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        placeholder="E.g. Swap 0.1 SOL to USDC"
        style={styles.input}
      />
      <Button title="Execute" onPress={handleSend} />

      {/* Logs */}
      <Text style={styles.logLabel}>Logs:</Text>
      <ScrollView
        style={styles.logScroll}
        ref={scrollViewRef}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
      >
        {logs.map((log, i) => (
          <Text
            key={`log-${i}`}
            style={[
              styles.logText,
              {
                color: log.includes("❌") || log.includes("Error") ? "#e53935"
                  : log.includes("✅") || log.includes("🟢") ? "#2e7d32"
                    : "#ccc"
              },
            ]}
          >
            {log}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── STYLES ─────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 60, backgroundColor: "#111" },
  title: { fontWeight: "bold", fontSize: 22, color: "#fff", marginBottom: 4 },
  subtitle: { fontSize: 11, color: "#888", marginBottom: 16 },
  buttonRow: { flexDirection: "row", marginBottom: 12 },
  btnWrap: { flex: 1 },
  input: {
    borderWidth: 1, borderColor: "#444", marginVertical: 10,
    padding: 12, borderRadius: 8, backgroundColor: "#222",
    fontSize: 15, color: "#fff",
  },
  logLabel: { marginTop: 16, fontWeight: "bold", fontSize: 14, color: "#fff" },
  logScroll: { flex: 1, marginTop: 8, backgroundColor: "#1a1a1a", borderRadius: 8, padding: 10 },
  logText: { fontFamily: "Courier New", fontSize: 12, lineHeight: 18 },
});
