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
import { ScrollView, Text, TextInput, TouchableOpacity, View, StyleSheet } from "react-native";
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

  const discriminator = Buffer.from([33]); // CreateMetadataAccountV3

  const data = Buffer.concat([
    discriminator,
    serializeString(name),
    serializeString(symbol),
    serializeString(uri),
    Buffer.from([0, 0]), // sellerFeeBasisPoints = 0
    Buffer.from([0]),    // creators = null
    Buffer.from([0]),    // collection = null
    Buffer.from([0]),    // uses = null
    Buffer.from([1]),    // isMutable = true
    Buffer.from([0]),    // collectionDetails = null
  ]);

  return {
    programId: METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data,
  };
};

// ═══════════════════════════════════════════════════════════════
// ─── MAIN APP ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState(["> Ready. Connect wallet first."]);
  const [paymentSig, setPaymentSig] = useState(null);
  const [deepLink, setDeepLink] = useState("");
  const scrollViewRef = useRef(null);

  const addLog = useCallback((log) => setLogs((prev) => [...prev, "> " + log]), []);

  // Crypto state
  const [dappKeyPair] = useState(nacl.box.keyPair());
  const [sharedSecret, setSharedSecret] = useState(null);
  const [session, setSession] = useState(null);
  const [phantomWalletPublicKey, setPhantomWalletPublicKey] = useState(null);

  // Multi-screen state
  const [activeTab, setActiveTab] = useState("agent");
  const [solBalance, setSolBalance] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const isConnected = !!phantomWalletPublicKey;
  const walletShort = isConnected
    ? `${phantomWalletPublicKey.toBase58().slice(0, 6)}...${phantomWalletPublicKey.toBase58().slice(-4)}`
    : null;

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

  // ─── DISCONNECT WALLET ────────────────────────────────────
  const disconnectWallet = () => {
    setSharedSecret(null);
    setSession(null);
    setPhantomWalletPublicKey(null);
    setSolBalance(null);
    addLog("🔴 Wallet disconnected");
  };

  // ─── FETCH BALANCE ────────────────────────────────────────
  const fetchBalance = async () => {
    if (!phantomWalletPublicKey) return;
    setBalanceLoading(true);
    try {
      const bal = await connection.getBalance(phantomWalletPublicKey);
      setSolBalance((bal / 1e9).toFixed(4));
    } catch (e) {
      addLog(`❌ Balance error: ${e.message}`);
    }
    setBalanceLoading(false);
  };

  // Auto-fetch balance on connect
  useEffect(() => {
    if (phantomWalletPublicKey) fetchBalance();
  }, [phantomWalletPublicKey]);

  // ─── REFRESH LOGS ─────────────────────────────────────────
  const refreshLogs = () => setLogs(["> Logs cleared. Ready."]);

  // ─── SIGN TRANSACTION ─────────────────────────────────────
  const signAndSendTx = async (txBase64, partialSigners = []) => {
    if (!session || !sharedSecret || !phantomWalletPublicKey) {
      addLog("⚠️ Connect wallet first!");
      return;
    }

    addLog("Building transaction for signing...");

    const txBuffer = Buffer.from(txBase64, "base64");
    const tx = Transaction.from(txBuffer);

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = phantomWalletPublicKey;

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

    const mintKeypair = Keypair.generate();
    addLog(`🔑 Generated Mint: ${mintKeypair.publicKey.toBase58().slice(0, 8)}...`);

    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    const userATA = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      phantomWalletPublicKey
    );

    const tx = new Transaction();

    tx.add(
      SystemProgram.createAccount({
        fromPubkey: phantomWalletPublicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      })
    );

    tx.add(
      createInitializeMintInstruction(
        mintKeypair.publicKey, 0,
        phantomWalletPublicKey, phantomWalletPublicKey,
        TOKEN_PROGRAM_ID
      )
    );

    tx.add(
      createAssociatedTokenAccountInstruction(
        phantomWalletPublicKey, userATA,
        phantomWalletPublicKey, mintKeypair.publicKey,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    tx.add(
      createMintToInstruction(
        mintKeypair.publicKey, userATA,
        phantomWalletPublicKey, 1, [],
        TOKEN_PROGRAM_ID
      )
    );

    const metadataIx = createMetadataInstruction(
      mintKeypair.publicKey, phantomWalletPublicKey,
      name, "AI", "https://arweave.net/123"
    );
    tx.add(metadataIx);

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = phantomWalletPublicKey;

    const serialized = tx.serialize({ requireAllSignatures: false }).toString("base64");
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

      if (res.status === 402) {
        const payData = await res.json();
        addLog(`💰 Payment Required: ${payData.amount} lamports`);
        const fakeSig = "mock_devnet_signature";
        setPaymentSig(fakeSig);
        addLog("Mock payment set. Click Execute again.");
        return;
      }

      const data = await res.json();
      addLog(`AI: ${data.message} [${data.action_type}]`);

      if (data.tx_base64) {
        if (phantomWalletPublicKey) {
          await signAndSendTx(data.tx_base64);
        } else {
          addLog("📋 Tx ready but no wallet. Connect first!");
        }
      } else if (data.action_type === "MINT_NFT") {
        const name = data.meta?.name || "AI Artwork";
        await mintNFT(name);
      }
    } catch (e) {
      addLog(`❌ Error: ${e.message}`);
    }
  };

  // ═══════════════════════════════════════════════════════════
  // ─── SCREEN: AGENT ─────────────────────────────────────────
  const AgentScreen = () => (
    <View style={{ flex: 1 }}>
      {/* Mini Status Bar */}
      <View style={s.miniStatus}>
        <View style={[s.miniDot, { backgroundColor: isConnected ? "#00e676" : "#ff4d6a" }]} />
        <Text style={s.miniStatusText}>
          {isConnected ? walletShort : "Not Connected"}
        </Text>
        {solBalance && <Text style={s.miniBalance}>{solBalance} SOL</Text>}
      </View>

      {/* Command Input Card */}
      <View style={s.inputCard}>
        <Text style={s.inputLabel}>AI COMMAND</Text>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder='Try: "Swap 0.1 SOL to USDC"'
          placeholderTextColor="#6b5b95"
          style={s.input}
        />
        <TouchableOpacity style={s.executeBtn} onPress={handleSend} activeOpacity={0.7}>
          <Text style={s.executeBtnText}>⚡ EXECUTE</Text>
        </TouchableOpacity>
      </View>

      {/* Quick Actions */}
      <Text style={s.sectionLabel}>QUICK ACTIONS</Text>
      <View style={s.quickRow}>
        {[
          { label: "Swap", cmd: "Swap 0.1 SOL to USDC" },
          { label: "Send", cmd: "Send 0.01 SOL to " },
          { label: "Mint NFT", cmd: "Mint an NFT called " },
        ].map((q) => (
          <TouchableOpacity
            key={q.label}
            style={s.quickBtn}
            onPress={() => setPrompt(q.cmd)}
            activeOpacity={0.7}
          >
            <Text style={s.quickBtnText}>{q.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Recent Activity Preview */}
      <View style={s.previewCard}>
        <View style={s.previewHeader}>
          <Text style={s.sectionLabelInline}>RECENT</Text>
          <TouchableOpacity onPress={() => setActiveTab("activity")}>
            <Text style={s.viewAllText}>View All →</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={{ maxHeight: 140 }} showsVerticalScrollIndicator={false}>
          {logs.slice(-5).reverse().map((log, i) => (
            <Text key={`preview-${i}`} style={s.previewLog} numberOfLines={1}>
              {log}
            </Text>
          ))}
        </ScrollView>
      </View>
    </View>
  );

  // ─── SCREEN: ACTIVITY ──────────────────────────────────────
  const ActivityScreen = () => (
    <View style={{ flex: 1 }}>
      <View style={s.screenHeader}>
        <Text style={s.screenTitle}>Activity Log</Text>
        <TouchableOpacity style={s.refreshBtn} onPress={refreshLogs} activeOpacity={0.7}>
          <Text style={s.refreshBtnText}>↻ Clear</Text>
        </TouchableOpacity>
      </View>

      <View style={s.logCard}>
        <View style={s.logHeaderRow}>
          <Text style={s.logBadge}>{logs.length} entries</Text>
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
            const isSystemLog = log.includes("📡") || log.includes("🔐");
            const color = isError ? "#ff4d6a"
              : isSuccess ? "#00e676"
                : isWarning ? "#ffab40"
                  : isMint ? "#e040fb"
                    : isSystemLog ? "#7c4dff"
                      : "#9e9eb8";
            return (
              <Text key={`log-${i}`} style={[s.logText, { color }]}>
                {log}
              </Text>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );

  // ─── SCREEN: WALLET ────────────────────────────────────────
  const WalletScreen = () => (
    <View style={{ flex: 1 }}>
      <Text style={s.screenTitleStandalone}>Wallet</Text>

      {/* Wallet Card */}
      <View style={s.walletCard}>
        <View style={[s.walletDot, { backgroundColor: isConnected ? "#00e676" : "#ff4d6a" }]} />
        <Text style={s.walletStatus}>
          {isConnected ? "CONNECTED" : "DISCONNECTED"}
        </Text>

        {isConnected ? (
          <>
            <Text style={s.walletAddress}>{phantomWalletPublicKey.toBase58()}</Text>
            <View style={s.balanceBox}>
              <Text style={s.balanceLabel}>Balance</Text>
              <Text style={s.balanceValue}>
                {balanceLoading ? "..." : solBalance ? `${solBalance} SOL` : "—"}
              </Text>
            </View>
            <TouchableOpacity onPress={fetchBalance}>
              <Text style={s.refreshBalText}>↻ Refresh Balance</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={s.walletHint}>Connect your Phantom wallet to get started</Text>
        )}
      </View>

      {/* Action Buttons */}
      {!isConnected ? (
        <TouchableOpacity style={s.connectBtn} onPress={connectWallet} activeOpacity={0.8}>
          <Text style={s.connectBtnText}>⚡ CONNECT PHANTOM</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={s.disconnectBtn} onPress={disconnectWallet} activeOpacity={0.8}>
          <Text style={s.disconnectBtnText}>✕ DISCONNECT WALLET</Text>
        </TouchableOpacity>
      )}

      {/* Network Info */}
      <View style={s.networkCard}>
        <Text style={s.networkLabel}>NETWORK</Text>
        <View style={s.networkRow}>
          <Text style={s.networkValue}>Solana Devnet</Text>
          <View style={s.networkLive} />
        </View>
        <Text style={s.networkRpc}>{SOLANA_RPC}</Text>
      </View>
    </View>
  );

  // ═══════════════════════════════════════════════════════════
  // ─── MAIN RENDER ───────────────────────────────────────────
  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.headerBar}>
        <Text style={s.logo}>⚡ SOLANA AI</Text>
        <Text style={s.versionBadge}>v2.0</Text>
      </View>

      {/* Active Screen */}
      <View style={{ flex: 1 }}>
        {activeTab === "agent" && <AgentScreen />}
        {activeTab === "activity" && <ActivityScreen />}
        {activeTab === "wallet" && <WalletScreen />}
      </View>

      {/* Bottom Tab Bar */}
      <View style={s.tabBar}>
        {[
          { id: "agent", icon: "🤖", label: "Agent" },
          { id: "activity", icon: "📋", label: "Activity" },
          { id: "wallet", icon: "👛", label: "Wallet" },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={s.tab}
            onPress={() => setActiveTab(tab.id)}
            activeOpacity={0.7}
          >
            <Text style={s.tabIcon}>{tab.icon}</Text>
            <Text style={[s.tabLabel, activeTab === tab.id && s.tabLabelActive]}>
              {tab.label}
            </Text>
            {activeTab === tab.id && <View style={s.tabIndicator} />}
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════
// ─── STYLES ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  // ── Root ──
  container: { flex: 1, backgroundColor: "#0a0a1a", paddingTop: 56 },

  // ── Header ──
  headerBar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: "#1f1a3e",
  },
  logo: { fontSize: 20, fontWeight: "900", color: "#e0d4ff", letterSpacing: 2 },
  versionBadge: {
    fontSize: 11, color: "#7c3aed", fontWeight: "700",
    backgroundColor: "rgba(124, 58, 237, 0.15)",
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: "hidden",
  },

  // ── Mini Status ──
  miniStatus: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 20, paddingVertical: 12,
  },
  miniDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  miniStatusText: { fontSize: 12, color: "#7c6baa", fontFamily: "Courier New", flex: 1 },
  miniBalance: { fontSize: 12, color: "#a78bfa", fontWeight: "700", fontFamily: "Courier New" },

  // ── Input Card ──
  inputCard: {
    backgroundColor: "#12122a", borderRadius: 16, padding: 16,
    marginHorizontal: 20, marginBottom: 16,
    borderWidth: 1, borderColor: "#2a1f5e",
  },
  inputLabel: { fontSize: 11, fontWeight: "700", color: "#7c6baa", letterSpacing: 2, marginBottom: 10 },
  input: {
    backgroundColor: "#0d0d20", borderWidth: 1, borderColor: "#3a2e6e",
    borderRadius: 12, padding: 14, fontSize: 15, color: "#e0d4ff", marginBottom: 12,
  },
  executeBtn: {
    backgroundColor: "#7c3aed", borderRadius: 12, paddingVertical: 14, alignItems: "center",
    shadowColor: "#7c3aed", shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5, shadowRadius: 8, elevation: 4,
  },
  executeBtnText: { color: "#fff", fontWeight: "800", fontSize: 15, letterSpacing: 1.5 },

  // ── Quick Actions ──
  sectionLabel: { fontSize: 11, fontWeight: "700", color: "#7c6baa", letterSpacing: 2, paddingHorizontal: 20, marginBottom: 10 },
  sectionLabelInline: { fontSize: 11, fontWeight: "700", color: "#7c6baa", letterSpacing: 2 },
  quickRow: { flexDirection: "row", paddingHorizontal: 20, marginBottom: 16, gap: 10 },
  quickBtn: {
    flex: 1, backgroundColor: "#1a1a35", borderRadius: 12,
    paddingVertical: 12, alignItems: "center",
    borderWidth: 1, borderColor: "#2a1f5e",
  },
  quickBtnText: { color: "#a78bfa", fontWeight: "700", fontSize: 13 },

  // ── Preview Card ──
  previewCard: {
    flex: 1, backgroundColor: "#0d0d20", borderRadius: 16, padding: 14,
    marginHorizontal: 20, borderWidth: 1, borderColor: "#1f1a3e",
  },
  previewHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  viewAllText: { fontSize: 12, color: "#7c3aed", fontWeight: "600" },
  previewLog: { fontSize: 12, color: "#9e9eb8", fontFamily: "Courier New", lineHeight: 22 },

  // ── Activity Screen ──
  screenHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, paddingVertical: 12,
  },
  screenTitle: { fontSize: 22, fontWeight: "800", color: "#e0d4ff" },
  screenTitleStandalone: { fontSize: 22, fontWeight: "800", color: "#e0d4ff", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  refreshBtn: {
    backgroundColor: "#1a1a35", borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: "#2a1f5e",
  },
  refreshBtnText: { color: "#a78bfa", fontWeight: "700", fontSize: 13 },
  logCard: {
    flex: 1, backgroundColor: "#0d0d20", borderRadius: 16, padding: 14,
    marginHorizontal: 20, borderWidth: 1, borderColor: "#1f1a3e",
  },
  logHeaderRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 8 },
  logBadge: {
    fontSize: 11, fontWeight: "700", color: "#9333ea",
    backgroundColor: "rgba(147, 51, 234, 0.15)",
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: "hidden",
  },
  logScroll: { flex: 1 },
  logText: { fontFamily: "Courier New", fontSize: 12, lineHeight: 20, marginBottom: 2 },

  // ── Wallet Screen ──
  walletCard: {
    backgroundColor: "#12122a", borderRadius: 20, padding: 24,
    marginHorizontal: 20, marginTop: 8, marginBottom: 16,
    borderWidth: 1, borderColor: "#2a1f5e", alignItems: "center",
    shadowColor: "#7c3aed", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 12, elevation: 8,
  },
  walletDot: { width: 14, height: 14, borderRadius: 7, marginBottom: 12 },
  walletStatus: { fontSize: 13, fontWeight: "800", color: "#7c6baa", letterSpacing: 3, marginBottom: 16 },
  walletAddress: { fontSize: 11, color: "#9e9eb8", fontFamily: "Courier New", textAlign: "center", marginBottom: 20, paddingHorizontal: 10 },
  balanceBox: {
    flexDirection: "row", justifyContent: "space-between", width: "100%",
    backgroundColor: "#0d0d20", borderRadius: 12, padding: 16, marginBottom: 12,
  },
  balanceLabel: { fontSize: 14, color: "#7c6baa", fontWeight: "600" },
  balanceValue: { fontSize: 16, color: "#e0d4ff", fontWeight: "800" },
  refreshBalText: { color: "#7c3aed", fontWeight: "600", fontSize: 13, paddingVertical: 8 },
  walletHint: { fontSize: 14, color: "#5a5a7c", textAlign: "center", marginTop: 8 },
  connectBtn: {
    backgroundColor: "#7c3aed", borderRadius: 14, paddingVertical: 16, alignItems: "center",
    marginHorizontal: 20, marginBottom: 16,
    shadowColor: "#7c3aed", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5, shadowRadius: 10, elevation: 6,
  },
  connectBtnText: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: 1.5 },
  disconnectBtn: {
    backgroundColor: "rgba(255, 77, 106, 0.1)", borderRadius: 14,
    paddingVertical: 16, alignItems: "center",
    marginHorizontal: 20, marginBottom: 16,
    borderWidth: 1, borderColor: "rgba(255, 77, 106, 0.3)",
  },
  disconnectBtnText: { color: "#ff4d6a", fontWeight: "800", fontSize: 15, letterSpacing: 1 },
  networkCard: {
    backgroundColor: "#12122a", borderRadius: 16, padding: 20,
    marginHorizontal: 20, borderWidth: 1, borderColor: "#2a1f5e",
  },
  networkLabel: { fontSize: 11, fontWeight: "700", color: "#7c6baa", letterSpacing: 2, marginBottom: 10 },
  networkRow: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  networkValue: { fontSize: 16, fontWeight: "700", color: "#e0d4ff", marginRight: 10 },
  networkLive: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#00e676" },
  networkRpc: { fontSize: 11, color: "#5a5a7c", fontFamily: "Courier New" },

  // ── Bottom Tab Bar ──
  tabBar: {
    flexDirection: "row", borderTopWidth: 1, borderTopColor: "#1f1a3e",
    backgroundColor: "#0d0d20", paddingBottom: 28, paddingTop: 10,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 4 },
  tabIcon: { fontSize: 22, marginBottom: 4 },
  tabLabel: { fontSize: 11, fontWeight: "600", color: "#5a5a7c" },
  tabLabelActive: { color: "#a78bfa" },
  tabIndicator: {
    width: 20, height: 3, borderRadius: 2, backgroundColor: "#7c3aed",
    marginTop: 4,
  },
});
