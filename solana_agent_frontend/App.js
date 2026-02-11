import "./polyfills"; // MUST be first — sets up Buffer before Solana libs load
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  Keypair
} from "@solana/web3.js";
import {
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Linking, StatusBar, Animated, Dimensions, Platform,
  KeyboardAvoidingView, ActivityIndicator,
} from "react-native";
import nacl from "tweetnacl";
import bs58 from "bs58";

// ─── CONSTANTS ──────────────────────────────────────────────
const API_URL = "http://172.20.10.5:3000/execute";
const DEVNET_RPC = "https://api.devnet.solana.com";
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";

const onConnectRedirectLink = Linking.createURL("onConnect");
const onSignTransactionRedirectLink = Linking.createURL("onSignTransaction");
const useUniversalLinks = false;

// ─── DESIGN TOKENS ──────────────────────────────────────────
const C = {
  bg: "#0B0E17",
  bgCard: "#11152A",
  bgGlass: "rgba(255,255,255,0.04)",
  primary: "#8B5CF6",
  primarySoft: "#A78BFA",
  accent: "#22D3EE",
  text: "#EDEDF3",
  textSec: "#A1A1C2",
  textMuted: "#6B6F9A",
  success: "#22C55E",
  warning: "#FACC15",
  error: "#EF4444",
  border: "rgba(255,255,255,0.06)",
  borderFocus: "rgba(139,92,246,0.4)",
  glass: "rgba(17,21,42,0.85)",
};

// ─── ENCRYPTION HELPERS ─────────────────────────────────────
function buildUrl(path, params) {
  return `${useUniversalLinks ? "https://phantom.app/ul/" : "phantom://"}v1/${path}?${params.toString()}`;
}

function decryptPayload(data, nonce, sharedSecret) {
  if (!sharedSecret) throw new Error("missing shared secret");
  const d = nacl.box.open.after(
    bs58.decode(data),
    bs58.decode(nonce),
    sharedSecret
  );
  if (!d) throw new Error("Unable to decrypt payload");
  return JSON.parse(Buffer.from(d).toString("utf8"));
}

function encryptPayload(payload, sharedSecret) {
  if (!sharedSecret) throw new Error("missing shared secret");
  const nonce = nacl.randomBytes(24);
  const enc = nacl.box.after(
    Buffer.from(JSON.stringify(payload)),
    nonce,
    sharedSecret
  );
  return [nonce, enc];
}

// ─── HELPER: SERIALIZE STRING ──────────────────────────────
function serializeString(str) {
  const buf = Buffer.from(str, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

// ─── HELPER: CREATE METADATA INSTRUCTION ──────────────────
function createMetadataInstruction(mint, payer, name, symbol, uri) {
  const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  const accounts = [
    { pubkey: metadataPDA, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: payer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const nameData = serializeString(name);
  const symbolData = serializeString(symbol);
  const uriData = serializeString(uri);
  const sellerFeeBasisPoints = Buffer.alloc(2);
  sellerFeeBasisPoints.writeUInt16LE(0, 0);
  const data = Buffer.concat([
    Buffer.from([33]),
    nameData, symbolData, uriData,
    sellerFeeBasisPoints,
    Buffer.from([0]),
    Buffer.from([1]),
    Buffer.from([1, 0, 0, 0]),
    payer.toBuffer(),
    Buffer.from([1]),
    Buffer.from([100]),
    Buffer.from([0]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
  return { keys: accounts, programId: TOKEN_METADATA_PROGRAM_ID, data };
}

// ═══════════════════════════════════════════════════════════════
// ─── MAIN APP ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

export default function App() {
  // ─── Wallet State ─────────────────────────────────────────
  const [dappKeyPair] = useState(() => nacl.box.keyPair());
  const [sharedSecret, setSharedSecret] = useState(null);
  const [session, setSession] = useState(null);
  const [phantomWalletPublicKey, setPhantomWalletPublicKey] = useState(null);
  const [balance, setBalance] = useState(null);

  // ─── Network ──────────────────────────────────────────────
  const [network, setNetwork] = useState("devnet");
  const connection = new Connection(network === "mainnet" ? MAINNET_RPC : DEVNET_RPC, "confirmed");

  // ─── UI State ─────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState([]);
  const [appState, setAppState] = useState("idle"); // idle | parsing | ready | confirming | sending | done | error
  const [interpretation, setInterpretation] = useState(null);
  const [pendingTx, setPendingTx] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [paymentSig, setPaymentSig] = useState(null);
  const [activeTab, setActiveTab] = useState("agent");

  // ─── Animations ───────────────────────────────────────────
  const cardAnim = useRef(new Animated.Value(0)).current;
  const feedScrollRef = useRef(null);

  const addLog = useCallback((msg) => {
    setLogs(prev => [...prev, { id: Date.now(), text: msg, time: new Date() }]);
  }, []);

  // ─── Auto-scroll feed ────────────────────────────────────
  useEffect(() => {
    if (feedScrollRef.current) {
      setTimeout(() => feedScrollRef.current?.scrollToEnd?.({ animated: true }), 100);
    }
  }, [logs]);

  // ─── Animate interpretation card ─────────────────────────
  useEffect(() => {
    Animated.spring(cardAnim, {
      toValue: interpretation ? 1 : 0,
      useNativeDriver: true,
      tension: 80,
      friction: 12,
    }).start();
  }, [interpretation]);

  // ─── DEEP LINK HANDLER ───────────────────────────────────
  useEffect(() => {
    const sub = Linking.addEventListener("url", handleLink);
    return () => sub.remove();
  }, [sharedSecret, session]);

  const handleLink = useCallback(({ url }) => {
    const parsed = Linking.parse(url);
    const { path } = parsed;
    const params = parsed.queryParams || {};

    if (path === "onConnect" && params.phantom_encryption_public_key) {
      const phantomPub = bs58.decode(params.phantom_encryption_public_key);
      const secret = nacl.box.before(phantomPub, dappKeyPair.secretKey);
      setSharedSecret(secret);
      const connectData = decryptPayload(params.data, params.nonce, secret);
      setSession(connectData.session);
      const pk = new PublicKey(connectData.public_key);
      setPhantomWalletPublicKey(pk);
      addLog(`🟢 Connected: ${pk.toBase58().slice(0, 6)}...${pk.toBase58().slice(-4)}`);
      fetchBalance(pk);
    }

    if (path === "onSignTransaction" && params.data && sharedSecret) {
      try {
        const signedData = decryptPayload(params.data, params.nonce, sharedSecret);
        const signedTx = signedData.transaction;
        if (signedTx) {
          addLog("🚀 Sending signed transaction...");
          const rawTx = bs58.decode(signedTx);
          connection.sendRawTransaction(rawTx, { skipPreflight: false })
            .then((sig) => {
              addLog(`✅ Confirmed — ${sig.slice(0, 8)}...`);
              addLog(`🔗 https://solscan.io/tx/${sig}${network === "devnet" ? "?cluster=devnet" : ""}`);
              setAppState("done");
              fetchBalance(phantomWalletPublicKey);
            })
            .catch((err) => {
              addLog(`❌ Send error: ${err.message}`);
              setAppState("error");
            });
        }
      } catch (e) {
        addLog(`❌ Sign error: ${e.message}`);
        setAppState("error");
      }
    }
  }, [sharedSecret, session, connection, network, phantomWalletPublicKey]);

  // ─── CONNECT TO PHANTOM ─────────────────────────────────
  const connectWallet = () => {
    const params = new URLSearchParams({
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      cluster: network === "mainnet" ? "mainnet-beta" : "devnet",
      app_url: "https://solana-ai-agent.app",
      redirect_link: onConnectRedirectLink,
    });
    Linking.openURL(buildUrl("connect", params));
  };

  const disconnectWallet = () => {
    setSession(null);
    setSharedSecret(null);
    setPhantomWalletPublicKey(null);
    setBalance(null);
    setAppState("idle");
    setInterpretation(null);
    setPendingTx(null);
    addLog("🔴 Wallet disconnected");
  };

  // ─── FETCH BALANCE ──────────────────────────────────────
  const fetchBalance = async (pubkey) => {
    try {
      const pk = pubkey || phantomWalletPublicKey;
      if (!pk) return;
      const bal = await connection.getBalance(pk);
      setBalance((bal / 1e9).toFixed(4));
    } catch (e) {
      setBalance("—");
    }
  };

  // ─── SIGN & SEND TRANSACTION ────────────────────────────
  const signAndSendTx = async (txBase64, partialSigners = []) => {
    if (!session || !sharedSecret || !phantomWalletPublicKey) {
      addLog("⚠️ Connect wallet first!");
      return;
    }

    addLog("📝 Building transaction...");
    setAppState("sending");

    const txBuffer = Buffer.from(txBase64, "base64");
    const txBytes = new Uint8Array(txBuffer);
    let serializedTx;

    // Try versioned transaction first (Jupiter swaps), fall back to legacy
    try {
      const vtx = VersionedTransaction.deserialize(txBytes);
      addLog("🔄 Versioned transaction (v0)");
      const { blockhash } = await connection.getLatestBlockhash();
      vtx.message.recentBlockhash = blockhash;
      serializedTx = Buffer.from(vtx.serialize());
    } catch (_vErr) {
      try {
        const tx = Transaction.from(txBuffer);
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = phantomWalletPublicKey;
        if (partialSigners.length > 0) {
          tx.partialSign(...partialSigners);
        }
        serializedTx = tx.serialize({ requireAllSignatures: false });
      } catch (lErr) {
        addLog(`❌ TX parse failed: ${lErr.message}`);
        setAppState("error");
        return;
      }
    }

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

    addLog("✍️ Opening Phantom to sign...");
    const url = buildUrl("signTransaction", params);
    Linking.openURL(url);
  };

  // ─── MINT NFT LOGIC ────────────────────────────────────
  const mintNFT = async (name) => {
    if (!phantomWalletPublicKey) { addLog("⚠️ Connect wallet first!"); return; }
    addLog("🎨 Building NFT mint...");
    const mintKeypair = Keypair.generate();
    const tx = new Transaction();
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: phantomWalletPublicKey, newAccountPubkey: mintKeypair.publicKey,
        space: 82, lamports: await connection.getMinimumBalanceForRentExemption(82),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKeypair.publicKey, 0, phantomWalletPublicKey, phantomWalletPublicKey),
    );
    const userATA = await getAssociatedTokenAddress(mintKeypair.publicKey, phantomWalletPublicKey);
    tx.add(
      createAssociatedTokenAccountInstruction(phantomWalletPublicKey, userATA, phantomWalletPublicKey, mintKeypair.publicKey),
      createMintToInstruction(mintKeypair.publicKey, userATA, phantomWalletPublicKey, 1, [], TOKEN_PROGRAM_ID)
    );
    const metadataIx = createMetadataInstruction(mintKeypair.publicKey, phantomWalletPublicKey, name, "AI", "https://arweave.net/123");
    tx.add(metadataIx);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = phantomWalletPublicKey;
    const serialized = tx.serialize({ requireAllSignatures: false }).toString("base64");
    await signAndSendTx(serialized, [mintKeypair]);
  };

  // ─── MAIN HANDLER: PARSE INTENT ─────────────────────────
  const handleSend = async () => {
    if (!prompt.trim()) return;
    try {
      const currentPubkey = phantomWalletPublicKey
        ? phantomWalletPublicKey.toBase58()
        : "11111111111111111111111111111111";

      setAppState("parsing");
      addLog("🧠 Analyzing your request...");

      const headers = { "Content-Type": "application/json" };
      if (paymentSig) headers["X-Payment-Sig"] = paymentSig;

      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, user_pubkey: currentPubkey, network }),
      });

      if (res.status === 402) {
        const payData = await res.json();
        addLog(`💰 Payment Required: ${payData.amount} lamports`);
        setPaymentSig("mock_devnet_signature");
        addLog("Mock payment set. Tap Execute again.");
        setAppState("idle");
        return;
      }

      const data = await res.json();

      if (data.action_type === "ERROR") {
        addLog(`❌ ${data.message}`);
        setAppState("error");
        return;
      }

      addLog(`🤖 ${data.message}`);

      if (data.action_type === "MINT_NFT") {
        const name = data.meta?.name || "AI Artwork";
        setAppState("confirming");
        setInterpretation({ action: "Mint NFT", name, network, fee: "~0.01 SOL" });
        setPendingAction(() => () => mintNFT(name));
        return;
      }

      if (data.tx_base64) {
        // Show interpretation card for confirmation
        setInterpretation(data.meta || { action: data.action_type, network });
        setPendingTx(data.tx_base64);
        setAppState("ready");
        addLog("📋 Review the transaction below");
      }
    } catch (e) {
      addLog(`❌ ${e.message}`);
      setAppState("error");
    }
  };

  // ─── CONFIRM & EXECUTE ──────────────────────────────────
  const handleConfirm = async () => {
    setAppState("confirming");
    if (pendingAction) {
      await pendingAction();
      setPendingAction(null);
    } else if (pendingTx) {
      if (!phantomWalletPublicKey) {
        addLog("⚠️ Connect wallet first!");
        setAppState("error");
        return;
      }
      await signAndSendTx(pendingTx);
    }
    setInterpretation(null);
    setPendingTx(null);
  };

  const handleCancel = () => {
    setInterpretation(null);
    setPendingTx(null);
    setPendingAction(null);
    setAppState("idle");
    addLog("↩️ Transaction cancelled");
  };

  const resetState = () => {
    setAppState("idle");
    setInterpretation(null);
    setPendingTx(null);
    setPendingAction(null);
    setPrompt("");
  };

  // ─── QUICK ACTIONS ──────────────────────────────────────
  const quickActions = [
    { label: "Send", icon: "↗", prompt: "Send 0.01 SOL to " },
    { label: "Swap", icon: "🔄", prompt: "Swap 0.001 SOL to USDC" },
    { label: "Token", icon: "🪙", prompt: "Send 1 USDC to " },
    { label: "Mint", icon: "🎨", prompt: "Mint an NFT called " },
  ];

  // ═══════════════════════════════════════════════════════════
  // ─── CONTEXT-AWARE BUTTON ─────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const getButtonConfig = () => {
    switch (appState) {
      case "idle": return { label: "Review", onPress: handleSend, disabled: !prompt.trim(), color: C.primary };
      case "parsing": return { label: "Analyzing…", onPress: null, disabled: true, color: C.textMuted };
      case "ready": return { label: "Sign & Send", onPress: handleConfirm, disabled: false, color: C.success };
      case "confirming": return { label: "Confirming…", onPress: null, disabled: true, color: C.warning };
      case "sending": return { label: "Sending…", onPress: null, disabled: true, color: C.warning };
      case "done": return { label: "New Command", onPress: resetState, disabled: false, color: C.accent };
      case "error": return { label: "Try Again", onPress: resetState, disabled: false, color: C.error };
      default: return { label: "Review", onPress: handleSend, disabled: !prompt.trim(), color: C.primary };
    }
  };

  // ═══════════════════════════════════════════════════════════
  // ─── LOG FORMATTING ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const getLogColor = (text) => {
    if (text.startsWith("❌")) return C.error;
    if (text.startsWith("✅") || text.startsWith("🟢")) return C.success;
    if (text.startsWith("⚠️") || text.startsWith("💰")) return C.warning;
    if (text.startsWith("🔗")) return C.accent;
    if (text.startsWith("🤖") || text.startsWith("🧠")) return C.primarySoft;
    return C.textSec;
  };

  // ═══════════════════════════════════════════════════════════
  // ─── RENDER ──────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const btn = getButtonConfig();

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ─── HEADER ──────────────────────────────────────── */}
      <View style={s.header}>
        <View>
          <Text style={s.logoText}>SOLANA AI</Text>
          <Text style={s.versionText}>v3.0</Text>
        </View>

        {phantomWalletPublicKey ? (
          <TouchableOpacity style={s.walletPill} onPress={disconnectWallet}>
            <View style={[s.statusDot, { backgroundColor: C.success }]} />
            <Text style={s.walletPillText}>
              {phantomWalletPublicKey.toBase58().slice(0, 4)}...{phantomWalletPublicKey.toBase58().slice(-4)}
            </Text>
            <Text style={s.walletPillNetwork}>
              {network === "mainnet" ? "Main" : "Dev"}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[s.walletPill, s.walletPillDisconnected]} onPress={connectWallet}>
            <View style={[s.statusDot, { backgroundColor: C.error }]} />
            <Text style={s.walletPillText}>Connect</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ─── BALANCE BAR ─────────────────────────────────── */}
      {phantomWalletPublicKey && (
        <View style={s.balanceBar}>
          <Text style={s.balanceLabel}>Balance</Text>
          <Text style={s.balanceValue}>{balance || "—"} SOL</Text>
          <TouchableOpacity
            style={s.networkToggle}
            onPress={() => {
              const next = network === "devnet" ? "mainnet" : "devnet";
              setNetwork(next);
              addLog(`🌐 Switched to ${next === "mainnet" ? "Mainnet" : "Devnet"}`);
            }}
          >
            <View style={[s.networkDot, { backgroundColor: network === "mainnet" ? C.warning : C.accent }]} />
            <Text style={s.networkText}>{network === "mainnet" ? "Mainnet" : "Devnet"}</Text>
          </TouchableOpacity>
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={s.scrollArea}
          contentContainerStyle={{ paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* ─── INTENT INPUT CARD ───────────────────────── */}
          <View style={s.intentCard}>
            <Text style={s.intentLabel}>TELL YOUR AGENT WHAT TO DO</Text>
            <TextInput
              style={s.intentInput}
              placeholder='Send 0.5 SOL to dev wallet'
              placeholderTextColor={C.textMuted}
              value={prompt}
              onChangeText={setPrompt}
              multiline={false}
              returnKeyType="send"
              onSubmitEditing={appState === "idle" ? handleSend : undefined}
              editable={appState === "idle" || appState === "done" || appState === "error"}
            />
            <Text style={s.intentHint}>Natural language • Secure • Confirm before signing</Text>
          </View>

          {/* ─── QUICK ACTIONS ───────────────────────────── */}
          {appState === "idle" && (
            <View style={s.quickRow}>
              {quickActions.map((q) => (
                <TouchableOpacity
                  key={q.label}
                  style={s.quickChip}
                  onPress={() => setPrompt(q.prompt)}
                >
                  <Text style={s.quickIcon}>{q.icon}</Text>
                  <Text style={s.quickLabel}>{q.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* ─── AI INTERPRETATION CARD ──────────────────── */}
          {interpretation && (
            <Animated.View style={[
              s.interpCard,
              {
                opacity: cardAnim,
                transform: [{ translateY: cardAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
              },
            ]}>
              <View style={s.interpHeader}>
                <Text style={s.interpHeaderIcon}>🤖</Text>
                <Text style={s.interpHeaderText}>I understand this request</Text>
              </View>

              <View style={s.interpBody}>
                <InterpRow label="Action" value={interpretation.action} />
                {interpretation.amount != null && (
                  <InterpRow label="Amount" value={`${interpretation.amount} ${interpretation.token_in || ""}`} />
                )}
                {interpretation.token_out && (
                  <InterpRow label="To Token" value={interpretation.token_out} />
                )}
                {interpretation.recipient && (
                  <InterpRow label="Recipient" value={`${interpretation.recipient.slice(0, 6)}...${interpretation.recipient.slice(-4)}`} mono />
                )}
                {interpretation.name && (
                  <InterpRow label="Name" value={interpretation.name} />
                )}
                <InterpRow label="Network" value={interpretation.network === "mainnet" ? "Solana Mainnet" : "Solana Devnet"} />
                <InterpRow label="Est. Fee" value={interpretation.fee || "~0.000005 SOL"} />
              </View>

              <View style={s.interpActions}>
                <TouchableOpacity style={s.cancelBtn} onPress={handleCancel}>
                  <Text style={s.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.confirmBtn} onPress={handleConfirm}>
                  <Text style={s.confirmBtnText}>Sign & Send</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

          {/* ─── CONTEXT BUTTON ──────────────────────────── */}
          {!interpretation && (
            <TouchableOpacity
              style={[s.mainBtn, { backgroundColor: btn.color, opacity: btn.disabled ? 0.4 : 1 }]}
              onPress={btn.onPress}
              disabled={btn.disabled}
              activeOpacity={0.7}
            >
              {(appState === "parsing" || appState === "sending" || appState === "confirming") && (
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
              )}
              <Text style={s.mainBtnText}>{btn.label}</Text>
            </TouchableOpacity>
          )}

          {/* ─── AGENT FEED ──────────────────────────────── */}
          <View style={s.feedCard}>
            <View style={s.feedHeader}>
              <Text style={s.feedTitle}>Agent Feed</Text>
              <TouchableOpacity onPress={() => setLogs([])}>
                <Text style={s.feedClear}>Clear</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              ref={feedScrollRef}
              style={s.feedScroll}
              nestedScrollEnabled
            >
              {logs.length === 0 && (
                <Text style={s.feedEmpty}>No activity yet. Tell your agent what to do.</Text>
              )}
              {logs.map((log) => (
                <Text key={log.id} style={[s.feedLog, { color: getLogColor(log.text) }]}>
                  {log.text}
                </Text>
              ))}
            </ScrollView>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── INTERPRETATION ROW COMPONENT ────────────────────────────
function InterpRow({ label, value, mono }) {
  return (
    <View style={s.interpRow}>
      <Text style={s.interpLabel}>{label}</Text>
      <Text style={[s.interpValue, mono && s.interpMono]}>{value}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════
// ─── STYLES ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const { width } = Dimensions.get("window");

const s = StyleSheet.create({
  // ── Root ──
  container: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 56 },

  // ── Header ──
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  logoText: { fontSize: 18, fontWeight: "800", color: C.text, letterSpacing: 2 },
  versionText: { fontSize: 10, color: C.textMuted, letterSpacing: 1, marginTop: 2 },

  // ── Wallet Pill ──
  walletPill: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(139,92,246,0.12)",
    borderWidth: 1, borderColor: "rgba(139,92,246,0.3)",
    borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14,
    gap: 6,
  },
  walletPillDisconnected: {
    backgroundColor: "rgba(239,68,68,0.1)",
    borderColor: "rgba(239,68,68,0.3)",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  walletPillText: { fontSize: 13, color: C.text, fontWeight: "600" },
  walletPillNetwork: {
    fontSize: 10, color: C.textMuted, fontWeight: "700",
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    overflow: "hidden", letterSpacing: 0.5,
  },

  // ── Balance Bar ──
  balanceBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  balanceLabel: { fontSize: 12, color: C.textMuted, fontWeight: "600", letterSpacing: 1 },
  balanceValue: { fontSize: 16, color: C.text, fontWeight: "700" },
  networkToggle: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.04)",
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    borderWidth: 1, borderColor: C.border,
  },
  networkDot: { width: 6, height: 6, borderRadius: 3 },
  networkText: { fontSize: 11, color: C.textSec, fontWeight: "600" },

  // ── Scroll ──
  scrollArea: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },

  // ── Intent Card ──
  intentCard: {
    backgroundColor: C.glass,
    borderWidth: 1, borderColor: C.border,
    borderRadius: 16, padding: 20, marginBottom: 12,
  },
  intentLabel: {
    fontSize: 11, fontWeight: "700", color: C.textMuted,
    letterSpacing: 2, marginBottom: 12,
  },
  intentInput: {
    backgroundColor: "rgba(0,0,0,0.3)",
    borderWidth: 1, borderColor: C.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: C.text,
    marginBottom: 8,
  },
  intentHint: { fontSize: 11, color: C.textMuted, textAlign: "center" },

  // ── Quick Actions ──
  quickRow: {
    flexDirection: "row", gap: 8, marginBottom: 12, justifyContent: "center",
  },
  quickChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: C.bgGlass, borderWidth: 1, borderColor: C.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8,
  },
  quickIcon: { fontSize: 14 },
  quickLabel: { fontSize: 12, color: C.textSec, fontWeight: "600" },

  // ── AI Interpretation Card ──
  interpCard: {
    backgroundColor: "rgba(139,92,246,0.08)",
    borderWidth: 1, borderColor: "rgba(139,92,246,0.25)",
    borderRadius: 16, marginBottom: 12, overflow: "hidden",
  },
  interpHeader: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "rgba(139,92,246,0.15)",
  },
  interpHeaderIcon: { fontSize: 18 },
  interpHeaderText: { fontSize: 14, fontWeight: "700", color: C.primarySoft },
  interpBody: { padding: 16, gap: 8 },
  interpRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  interpLabel: { fontSize: 13, color: C.textMuted, fontWeight: "500" },
  interpValue: { fontSize: 13, color: C.text, fontWeight: "600" },
  interpMono: { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", fontSize: 12 },
  interpActions: {
    flexDirection: "row", gap: 10,
    paddingHorizontal: 16, paddingBottom: 14, justifyContent: "flex-end",
  },
  cancelBtn: {
    paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.06)", borderWidth: 1, borderColor: C.border,
  },
  cancelBtnText: { fontSize: 14, color: C.textSec, fontWeight: "600" },
  confirmBtn: {
    paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.success,
  },
  confirmBtnText: { fontSize: 14, color: "#fff", fontWeight: "700" },

  // ── Main Action Button ──
  mainBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    borderRadius: 14, paddingVertical: 15, marginBottom: 16,
  },
  mainBtnText: { fontSize: 16, fontWeight: "700", color: "#fff", letterSpacing: 0.5 },

  // ── Agent Feed ──
  feedCard: {
    backgroundColor: C.glass,
    borderWidth: 1, borderColor: C.border,
    borderRadius: 16, padding: 16, minHeight: 180,
  },
  feedHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: 10,
  },
  feedTitle: { fontSize: 13, fontWeight: "700", color: C.textSec, letterSpacing: 1 },
  feedClear: { fontSize: 11, color: C.textMuted },
  feedScroll: { maxHeight: 250 },
  feedEmpty: { fontSize: 12, color: C.textMuted, textAlign: "center", marginTop: 20 },
  feedLog: { fontSize: 12, lineHeight: 22, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },
});
