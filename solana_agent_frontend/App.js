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
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import bs58 from "bs58";
import { Buffer } from "buffer";
import * as Linking from "expo-linking";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ScrollView, Text, TextInput, TouchableOpacity, View,
  StyleSheet, StatusBar, Animated, Platform, ActivityIndicator,
} from "react-native";
import nacl from "tweetnacl";

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ─── CONFIG ─────────────────────────────────────────────────
const API_URL = "https://solana-ai-agent.onrender.com/agent/execute";

const onConnectRedirectLink = Linking.createURL("onConnect");
const onSignTransactionRedirectLink = Linking.createURL("onSignTransaction");

const useUniversalLinks = false;
const buildUrl = (path, params) =>
  `${useUniversalLinks ? "https://phantom.app/ul/" : "phantom://"}v1/${path}?${params.toString()}`;

// ─── DESIGN TOKENS ──────────────────────────────────────────
const C = {
  bg: "#0B0E17",
  bgCard: "#11152A",
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
  glass: "rgba(17,21,42,0.85)",
};

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

// ─── HELPER: SERIALIZE STRING ───────────────────────────────
const serializeString = (str) => {
  const buf = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  return Buffer.concat([len, buf]);
};

// ─── HELPER: CREATE METADATA INSTRUCTION ────────────────────
const createMetadataInstruction = (mint, payer, name, symbol, uri) => {
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  const data = Buffer.concat([
    Buffer.from([33]),
    serializeString(name), serializeString(symbol), serializeString(uri),
    Buffer.from([0, 0]), Buffer.from([0]), Buffer.from([0]),
    Buffer.from([0]), Buffer.from([1]), Buffer.from([0]),
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
    data,
  };
};

// ═══════════════════════════════════════════════════════════════
// ─── MAIN APP ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState([]);
  const [paymentSig, setPaymentSig] = useState(null);
  const [deepLink, setDeepLink] = useState("");
  const scrollViewRef = useRef(null);

  const addLog = useCallback((log) => setLogs((prev) => [...prev, log]), []);

  // Persist keypair in localStorage on web so Phantom redirects can decrypt
  // (localStorage survives across tabs — sessionStorage does NOT)
  const [dappKeyPair] = useState(() => {
    if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
      try {
        const saved = window.localStorage.getItem("dappKeyPair");
        if (saved) {
          const parsed = JSON.parse(saved);
          return {
            publicKey: new Uint8Array(parsed.publicKey),
            secretKey: new Uint8Array(parsed.secretKey),
          };
        }
      } catch (e) { /* ignore */ }
      const kp = nacl.box.keyPair();
      window.localStorage.setItem("dappKeyPair", JSON.stringify({
        publicKey: Array.from(kp.publicKey),
        secretKey: Array.from(kp.secretKey),
      }));
      return kp;
    }
    return nacl.box.keyPair();
  });
  const [sharedSecret, setSharedSecret] = useState(null);
  const [session, setSession] = useState(null);
  const [phantomWalletPublicKey, setPhantomWalletPublicKey] = useState(null);

  // Multi-screen state
  const [activeTab, setActiveTab] = useState("agent");
  const [solBalance, setSolBalance] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [onboardingStep, setOnboardingStep] = useState(0);

  // Network State
  const [network, setNetwork] = useState("devnet");
  const connection = React.useMemo(() =>
    new Connection(network === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com"
    ), [network]);

  // V3 State — AI Interpretation Card + Context Button
  const [appState, setAppState] = useState("idle"); // idle | parsing | ready | confirming | sending | done | error
  const [interpretation, setInterpretation] = useState(null);
  const [pendingTx, setPendingTx] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const cardAnim = useRef(new Animated.Value(0)).current;

  const isConnected = !!phantomWalletPublicKey;
  const walletShort = isConnected
    ? `${phantomWalletPublicKey.toBase58().slice(0, 4)}...${phantomWalletPublicKey.toBase58().slice(-4)}`
    : null;

  // ─── Animate interpretation card ─────────────────────────
  useEffect(() => {
    Animated.spring(cardAnim, {
      toValue: interpretation ? 1 : 0,
      useNativeDriver: true,
      tension: 80, friction: 12,
    }).start();
  }, [interpretation]);

  // ─── DEEP LINK LISTENER ──────────────────────────────────
  useEffect(() => {
    // On web, read the URL directly from the browser (expo-linking may miss it)
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const href = window.location.href;
      if (href && (href.includes("onConnect") || href.includes("onSignTransaction"))) {
        setDeepLink(href);
        // Clean URL so refresh doesn't re-trigger
        window.history.replaceState({}, "", "/");
      }
      return; // skip expo-linking on web
    }
    // On native, use expo-linking as normal
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
        addLog(`[WARN] Error ${params.get("errorCode")}: ${params.get("errorMessage")}`);
        return;
      }

      // ── CONNECT RESPONSE ──
      if (/onConnect/.test(url.pathname || url.host)) {
        try {
          const sharedSecretDapp = nacl.box.before(
            bs58.decode(params.get("phantom_encryption_public_key")),
            dappKeyPair.secretKey
          );
          const connectData = decryptPayload(params.get("data"), params.get("nonce"), sharedSecretDapp);
          setSharedSecret(sharedSecretDapp);
          setSession(connectData.session);
          setPhantomWalletPublicKey(new PublicKey(connectData.public_key));
          addLog(`[OK] Connected: ${connectData.public_key.slice(0, 8)}...`);
        } catch (e) {
          addLog(`[ERROR] Connect error: ${e.message}`);
        }
      }

      // ── SIGN TRANSACTION RESPONSE ──
      else if (/onSignTransaction/.test(url.pathname || url.host)) {
        try {
          const signData = decryptPayload(params.get("data"), params.get("nonce"), sharedSecret);
          addLog("[TX] Sending signed transaction...");
          const signedTx = bs58.decode(signData.transaction);
          const sig = await connection.sendRawTransaction(signedTx);
          addLog(`[OK] Confirmed: ${sig.slice(0, 12)}...`);
          addLog(`[LINK] solscan.io/tx/${sig.slice(0, 16)}...${network === "devnet" ? " (devnet)" : ""}`);
          setAppState("done");
          fetchBalance();
        } catch (e) {
          addLog(`[ERROR] Send error: ${e.message}`);
          setAppState("error");
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
      cluster: network === "mainnet" ? "mainnet-beta" : "devnet",
      app_url: "https://phantom.app",
      redirect_link: onConnectRedirectLink,
    });
    Linking.openURL(buildUrl("connect", params));
  };

  const disconnectWallet = () => {
    setSharedSecret(null);
    setSession(null);
    setPhantomWalletPublicKey(null);
    setSolBalance(null);
    setAppState("idle");
    setInterpretation(null);
    setPendingTx(null);
    addLog("[DISCONNECTED] Wallet disconnected");
  };

  // ─── FETCH BALANCE ──────────────────────────────────────
  const fetchBalance = async () => {
    if (!phantomWalletPublicKey) return;
    setBalanceLoading(true);
    try {
      const bal = await connection.getBalance(phantomWalletPublicKey);
      setSolBalance((bal / 1e9).toFixed(4));
    } catch (e) {
      addLog(`[ERROR] Balance error: ${e.message}`);
    }
    setBalanceLoading(false);
  };

  useEffect(() => {
    if (phantomWalletPublicKey) fetchBalance();
  }, [phantomWalletPublicKey]);

  const refreshLogs = () => { setLogs([]); addLog("Logs cleared. Ready."); };

  // ─── SIGN TRANSACTION ───────────────────────────────────
  const signAndSendTx = async (txBase64, partialSigners = []) => {
    if (!session || !sharedSecret || !phantomWalletPublicKey) {
      addLog("⚠️ Connect wallet first!");
      return;
    }

    addLog("Building transaction...");
    setAppState("sending");

    const txBuffer = Buffer.from(txBase64, "base64");
    const txBytes = new Uint8Array(txBuffer);
    let serializedTx;

    // Try versioned transaction first (Jupiter swaps), fall back to legacy
    try {
      const vtx = VersionedTransaction.deserialize(txBytes);
      addLog("[TX] Versioned transaction (v0)");
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
          addLog(`[SIGN] Partially signed with ${partialSigners.length} keypair(s)`);
        }
        serializedTx = tx.serialize({ requireAllSignatures: false });
      } catch (lErr) {
        addLog(`[ERROR] TX parse failed: ${lErr.message}`);
        setAppState("error");
        return;
      }
    }

    const payload = { session, transaction: bs58.encode(serializedTx) };
    const [nonce, encryptedPayload] = encryptPayload(payload, sharedSecret);
    const params = new URLSearchParams({
      dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
      nonce: bs58.encode(nonce),
      redirect_link: onSignTransactionRedirectLink,
      payload: bs58.encode(encryptedPayload),
    });

    addLog("Opening Phantom to sign...");
    Linking.openURL(buildUrl("signTransaction", params));
  };

  // ─── MINT NFT LOGIC ─────────────────────────────────────
  const mintNFT = async (name) => {
    addLog(`[MINT] Preparing NFT: "${name}"`);
    const mintKeypair = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const userATA = await getAssociatedTokenAddress(mintKeypair.publicKey, phantomWalletPublicKey);
    const tx = new Transaction();
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: phantomWalletPublicKey, newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKeypair.publicKey, 0, phantomWalletPublicKey, phantomWalletPublicKey, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(phantomWalletPublicKey, userATA, phantomWalletPublicKey, mintKeypair.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createMintToInstruction(mintKeypair.publicKey, userATA, phantomWalletPublicKey, 1, [], TOKEN_PROGRAM_ID),
    );
    tx.add(createMetadataInstruction(mintKeypair.publicKey, phantomWalletPublicKey, name, "AI", "https://arweave.net/123"));
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = phantomWalletPublicKey;
    const serialized = tx.serialize({ requireAllSignatures: false }).toString("base64");
    await signAndSendTx(serialized, [mintKeypair]);
  };

  // ─── MAIN HANDLER: Parse Intent (V3 Two-Step Flow) ──────
  const handleSend = async () => {
    if (!prompt.trim()) return;
    try {
      const currentPubkey = phantomWalletPublicKey
        ? phantomWalletPublicKey.toBase58()
        : "11111111111111111111111111111111";

      setAppState("parsing");
      addLog("Analyzing your request...");

      const headers = { "Content-Type": "application/json" };
      if (paymentSig) headers["X-Payment-Sig"] = paymentSig;

      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, user_pubkey: currentPubkey, network }),
      });

      if (res.status === 402) {
        const payData = await res.json();
        addLog(`[PAY] Payment Required: ${payData.amount} lamports`);
        setPaymentSig("mock_devnet_signature");
        setAppState("idle");
        return;
      }

      const data = await res.json();

      if (data.action_type === "ERROR") {
        addLog(`[ERROR] ${data.message}`);
        setAppState("error");
        return;
      }

      addLog(`AI: ${data.message}`);

      if (data.action_type === "MINT_NFT") {
        const name = data.meta?.name || "AI Artwork";
        setInterpretation({ action: "Mint NFT", name, network, fee: "~0.01 SOL" });
        setPendingAction(() => () => mintNFT(name));
        setAppState("ready");
        return;
      }

      if (data.tx_base64) {
        setInterpretation(data.meta || { action: data.action_type, network });
        setPendingTx(data.tx_base64);
        setAppState("ready");
        addLog("Review transaction below");
      }
    } catch (e) {
      addLog(`[ERROR] ${e.message}`);
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
        addLog("[WARN] Connect wallet first!");
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
    addLog("Cancelled");
  };

  const resetState = () => {
    setAppState("idle");
    setInterpretation(null);
    setPendingTx(null);
    setPendingAction(null);
    setPrompt("");
  };

  // ─── CONTEXT-AWARE BUTTON ───────────────────────────────
  const getButtonConfig = () => {
    switch (appState) {
      case "idle": return { label: "Review", disabled: !prompt.trim(), color: C.primary, onPress: handleSend };
      case "parsing": return { label: "Analyzing…", disabled: true, color: C.textMuted, onPress: null };
      case "ready": return { label: "Sign & Send", disabled: false, color: C.success, onPress: handleConfirm };
      case "confirming": return { label: "Confirming…", disabled: true, color: C.warning, onPress: null };
      case "sending": return { label: "Sending…", disabled: true, color: C.warning, onPress: null };
      case "done": return { label: "New Command", disabled: false, color: C.accent, onPress: resetState };
      case "error": return { label: "Try Again", disabled: false, color: C.error, onPress: resetState };
      default: return { label: "Review", disabled: !prompt.trim(), color: C.primary, onPress: handleSend };
    }
  };

  // ─── LOG COLOR HELPER ───────────────────────────────────
  const getLogColor = (text) => {
    if (text.includes("[ERROR]")) return C.error;
    if (text.includes("[OK]")) return C.success;
    if (text.includes("[WARN]") || text.includes("[PAY]")) return C.warning;
    if (text.includes("[LINK]")) return C.accent;
    if (text.startsWith("AI:")) return C.primarySoft;
    if (text.includes("[MINT]") || text.includes("[SIGN]") || text.includes("[TX]")) return C.primary;
    return C.textSec;
  };

  // ═══════════════════════════════════════════════════════════
  // ─── SCREEN: AGENT ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const btn = getButtonConfig();

  const AgentScreen = () => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
      {/* Wallet Status Pill */}
      <View style={s.statusRow}>
        <View style={[s.statusDot, { backgroundColor: isConnected ? C.success : C.error }]} />
        <Text style={s.statusText}>{isConnected ? walletShort : "Not Connected"}</Text>
        {solBalance && <Text style={s.statusBalance}>{solBalance} SOL</Text>}
        <TouchableOpacity
          style={s.networkPill}
          onPress={() => {
            setNetwork(n => n === "devnet" ? "mainnet" : "devnet");
            setSolBalance(null);
            addLog(`[NETWORK] Switched to ${network === "devnet" ? "Mainnet" : "Devnet"}`);
          }}
        >
          <View style={[s.networkDot, { backgroundColor: network === "mainnet" ? C.warning : C.accent }]} />
          <Text style={s.networkPillText}>{network === "mainnet" ? "Main" : "Dev"}</Text>
        </TouchableOpacity>
      </View>

      {/* Intent Input Card */}
      <View style={s.intentCard}>
        <Text style={s.intentLabel}>TELL YOUR AGENT WHAT TO DO</Text>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder='Send 0.5 SOL to dev wallet'
          placeholderTextColor={C.textMuted}
          style={s.intentInput}
          editable={appState === "idle" || appState === "done" || appState === "error"}
          onSubmitEditing={appState === "idle" ? handleSend : undefined}
        />

        {/* Context-Aware Button */}
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
      </View>

      {/* AI Interpretation Card */}
      {interpretation && (
        <Animated.View style={[
          s.interpCard,
          {
            opacity: cardAnim,
            transform: [{ translateY: cardAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          },
        ]}>
          <View style={s.interpHeader}>
            <Text style={s.interpHeaderIcon}>AI</Text>
            <Text style={s.interpHeaderText}>I understand this request</Text>
          </View>
          <View style={s.interpBody}>
            <InterpRow label="Action" value={interpretation.action} />
            {interpretation.amount != null && (
              <InterpRow label="Amount" value={`${interpretation.amount} ${interpretation.token_in || ""}`} />
            )}
            {interpretation.token_out && <InterpRow label="To Token" value={interpretation.token_out} />}
            {interpretation.recipient && (
              <InterpRow label="Recipient" value={`${interpretation.recipient.slice(0, 6)}...${interpretation.recipient.slice(-4)}`} mono />
            )}
            {interpretation.name && <InterpRow label="Name" value={interpretation.name} />}
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

      {/* Quick Actions */}
      <Text style={s.sectionLabel}>QUICK ACTIONS</Text>
      <View style={s.quickRow}>
        {[
          { label: "Send", icon: "↗", cmd: "Send 0.01 SOL to " },
          { label: "Swap", icon: "⇄", cmd: "Swap 0.001 SOL to USDC" },
          { label: "Token", icon: "◎", cmd: "Send 1 USDC to " },
          { label: "Mint", icon: "⬢", cmd: "Mint an NFT called " },
        ].map((q) => (
          <TouchableOpacity
            key={q.label}
            style={s.quickChip}
            onPress={() => {
              setAppState("idle");
              setInterpretation(null);
              setPendingTx(null);
              setPendingAction(null);
              setPrompt(q.cmd);
            }}
            activeOpacity={0.7}
          >
            <Text style={s.quickIcon}>{q.icon}</Text>
            <Text style={s.quickLabel}>{q.label}</Text>
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
            <Text key={`p-${i}`} style={[s.previewLog, { color: getLogColor(log) }]} numberOfLines={1}>{log}</Text>
          ))}
          {logs.length === 0 && <Text style={s.emptyText}>No activity yet</Text>}
        </ScrollView>
      </View>
    </ScrollView>
  );

  // ═══════════════════════════════════════════════════════════
  // ─── SCREEN: ACTIVITY ──────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const ActivityScreen = () => (
    <View style={{ flex: 1 }}>
      <View style={s.screenHeader}>
        <Text style={s.screenTitle}>Activity Log</Text>
        <TouchableOpacity style={s.clearBtn} onPress={refreshLogs} activeOpacity={0.7}>
          <Text style={s.clearBtnText}>↻ Clear</Text>
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
          {logs.map((log, i) => (
            <Text key={`log-${i}`} style={[s.logText, { color: getLogColor(log) }]}>{log}</Text>
          ))}
          {logs.length === 0 && <Text style={s.emptyText}>No logs yet. Execute a command to see activity.</Text>}
        </ScrollView>
      </View>
    </View>
  );

  // ═══════════════════════════════════════════════════════════
  // ─── SCREEN: WALLET ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const WalletScreen = () => (
    <View style={{ flex: 1 }}>
      <Text style={s.screenTitleStandalone}>Wallet</Text>

      {/* Wallet Card */}
      <View style={s.walletCard}>
        <View style={[s.walletCardDot, { backgroundColor: isConnected ? C.success : C.error }]} />
        <Text style={s.walletStatus}>{isConnected ? "CONNECTED" : "DISCONNECTED"}</Text>

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
          <Text style={s.connectBtnText}>CONNECT PHANTOM</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={s.disconnectBtn} onPress={disconnectWallet} activeOpacity={0.8}>
          <Text style={s.disconnectBtnText}>✕ DISCONNECT WALLET</Text>
        </TouchableOpacity>
      )}

      {/* Network Info */}
      <View style={s.networkCard}>
        <Text style={s.networkCardLabel}>NETWORK</Text>
        <View style={s.networkRow}>
          <Text style={s.networkValue}>
            {network === "mainnet" ? "Solana Mainnet" : "Solana Devnet"}
          </Text>
          <View style={[s.networkLive, { backgroundColor: network === "mainnet" ? C.success : C.warning }]} />
        </View>
        <Text style={s.networkRpc}>
          {network === "mainnet" ? "api.mainnet-beta.solana.com" : "api.devnet.solana.com"}
        </Text>

        <TouchableOpacity
          style={s.networkToggle}
          onPress={() => {
            setNetwork(n => n === "devnet" ? "mainnet" : "devnet");
            setSolBalance(null);
            addLog(`[NETWORK] Switched to ${network === "devnet" ? "Mainnet" : "Devnet"}`);
          }}
          activeOpacity={0.7}
        >
          <Text style={s.networkToggleText}>
            Switch to {network === "devnet" ? "Mainnet" : "Devnet"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ═══════════════════════════════════════════════════════════
  // ─── ONBOARDING DATA ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  const onboardingSteps = [
    {
      step: "01", title: "Welcome to Solana AI Agent",
      subtitle: "Your AI-powered crypto copilot",
      items: [
        "Talk to AI in plain English — it handles the blockchain",
        "Swap tokens, send SOL, mint NFTs — all with one command",
        "Powered by Gemini AI + Solana blockchain",
        "Your keys stay safe in Phantom wallet",
      ],
    },
    {
      step: "02", title: "How to Get Started",
      subtitle: "3 simple steps",
      items: [
        "1.  Go to Wallet tab and connect your Phantom wallet",
        "2.  Go to Agent tab and type a command in plain English",
        "3.  Tap Review — AI explains the transaction, you confirm & sign",
        'TIP: Try "Swap 0.1 SOL to USDC" or "Mint an NFT called MyArt"',
      ],
    },
    {
      step: "03", title: "Roadmap",
      subtitle: "What's in the pipeline",
      items: [
        "+  Spend limits & alerts — set max per transaction",
        "+  Transaction history — searchable on-chain log",
        "+  Token analytics — live price, volume, liquidity",
        "+  Scheduled actions — auto-DCA and timed sends",
        "+  Multi-wallet — manage several wallets at once",
        "+  Open-source SDK — build your own AI agent",
      ],
    },
  ];

  const currentStep = onboardingSteps[onboardingStep];
  const isLastStep = onboardingStep === onboardingSteps.length - 1;

  // ─── ONBOARDING OVERLAY ─────────────────────────────────
  if (showOnboarding) {
    return (
      <View style={s.onboardingContainer}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        {/* Progress Dots */}
        <View style={s.onboardingDots}>
          {onboardingSteps.map((_, i) => (
            <View key={i} style={[s.dot, i === onboardingStep && s.dotActive]} />
          ))}
        </View>

        <View style={s.onboardingCard}>
          <Text style={s.onboardingStep}>{currentStep.step}</Text>
          <Text style={s.onboardingTitle}>{currentStep.title}</Text>
          <Text style={s.onboardingSubtitle}>{currentStep.subtitle}</Text>
          <View style={s.onboardingDivider} />
          {currentStep.items.map((item, i) => (
            <Text key={i} style={s.onboardingItem}>{item}</Text>
          ))}
        </View>

        <View style={s.onboardingNav}>
          {onboardingStep > 0 ? (
            <TouchableOpacity onPress={() => setOnboardingStep((p) => p - 1)}>
              <Text style={s.onboardingBack}>← Back</Text>
            </TouchableOpacity>
          ) : <View />}
          <TouchableOpacity
            style={s.onboardingNextBtn}
            onPress={() => isLastStep ? setShowOnboarding(false) : setOnboardingStep((p) => p + 1)}
            activeOpacity={0.7}
          >
            <Text style={s.onboardingNextText}>{isLastStep ? "LET'S GO →" : "NEXT →"}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => setShowOnboarding(false)}>
          <Text style={s.onboardingSkip}>Skip →</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // ─── MAIN RENDER ───────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={s.headerBar}>
        <Text style={s.logo}>SOLANA AI</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <TouchableOpacity onPress={() => { setOnboardingStep(0); setShowOnboarding(true); }}>
            <Text style={s.infoBtn}>ℹ</Text>
          </TouchableOpacity>
          <Text style={s.versionBadge}>v3.0</Text>
        </View>
      </View>

      {/* Active Screen */}
      <View style={{ flex: 1 }}>
        {activeTab === "agent" && AgentScreen()}
        {activeTab === "activity" && ActivityScreen()}
        {activeTab === "wallet" && WalletScreen()}
      </View>

      {/* Bottom Tab Bar */}
      <View style={s.tabBar}>
        {[
          { id: "agent", icon: "◆", label: "Agent" },
          { id: "activity", icon: "◇", label: "Activity" },
          { id: "wallet", icon: "◈", label: "Wallet" },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={s.tab}
            onPress={() => setActiveTab(tab.id)}
            activeOpacity={0.7}
          >
            <Text style={s.tabIcon}>{tab.icon}</Text>
            <Text style={[s.tabLabel, activeTab === tab.id && s.tabLabelActive]}>{tab.label}</Text>
            {activeTab === tab.id && <View style={s.tabIndicator} />}
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ─── INTERPRETATION ROW ──────────────────────────────────────
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
const s = StyleSheet.create({
  // ── Root ──
  container: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 56 },

  // ── Header ──
  headerBar: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  logo: { fontSize: 20, fontWeight: "900", color: C.text, letterSpacing: 2 },
  infoBtn: { fontSize: 20, color: C.textMuted },
  versionBadge: {
    fontSize: 11, color: C.primary, fontWeight: "700",
    backgroundColor: "rgba(139,92,246,0.15)",
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: "hidden",
  },

  // ── Status Row (Agent Screen) ──
  statusRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 20, paddingVertical: 10,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: C.textSec, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", flex: 1 },
  statusBalance: { fontSize: 12, color: C.primarySoft, fontWeight: "700" },
  networkPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.04)",
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
    borderWidth: 1, borderColor: C.border,
  },
  networkDot: { width: 6, height: 6, borderRadius: 3 },
  networkPillText: { fontSize: 10, color: C.textSec, fontWeight: "700" },

  // ── Intent Card ──
  intentCard: {
    backgroundColor: C.bgCard, borderRadius: 16, padding: 16,
    marginHorizontal: 16, marginBottom: 12,
    borderWidth: 1, borderColor: C.border,
  },
  intentLabel: { fontSize: 11, fontWeight: "700", color: C.textMuted, letterSpacing: 2, marginBottom: 10 },
  intentInput: {
    backgroundColor: "rgba(0,0,0,0.3)", borderWidth: 1, borderColor: C.border,
    borderRadius: 12, padding: 14, fontSize: 15, color: C.text, marginBottom: 12,
  },

  // ── Main Button ──
  mainBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    borderRadius: 12, paddingVertical: 14,
  },
  mainBtnText: { fontSize: 15, fontWeight: "700", color: "#fff", letterSpacing: 0.5 },

  // ── AI Interpretation Card ──
  interpCard: {
    backgroundColor: "rgba(139,92,246,0.08)",
    borderWidth: 1, borderColor: "rgba(139,92,246,0.25)",
    borderRadius: 16, marginHorizontal: 16, marginBottom: 16, overflow: "hidden",
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

  // ── Quick Actions ──
  sectionLabel: { fontSize: 11, fontWeight: "700", color: C.textMuted, letterSpacing: 2, marginHorizontal: 20, marginBottom: 8 },
  quickRow: {
    flexDirection: "row", gap: 8, marginHorizontal: 16, marginBottom: 16, flexWrap: "wrap",
  },
  quickChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 1, borderColor: C.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8,
  },
  quickIcon: { fontSize: 14 },
  quickLabel: { fontSize: 12, color: C.textSec, fontWeight: "600" },

  // ── Recent Preview Card ──
  previewCard: {
    backgroundColor: C.bgCard, borderRadius: 16, padding: 16,
    marginHorizontal: 16, borderWidth: 1, borderColor: C.border,
  },
  previewHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sectionLabelInline: { fontSize: 11, fontWeight: "700", color: C.textMuted, letterSpacing: 2 },
  viewAllText: { fontSize: 12, color: C.primary, fontWeight: "600" },
  previewLog: { fontSize: 12, lineHeight: 22, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },
  emptyText: { fontSize: 12, color: C.textMuted, textAlign: "center", marginVertical: 16 },

  // ── Activity Screen ──
  screenHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 20, paddingVertical: 16,
  },
  screenTitle: { fontSize: 18, fontWeight: "800", color: C.text },
  clearBtn: {
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: C.border,
  },
  clearBtnText: { fontSize: 12, color: C.textSec, fontWeight: "600" },
  logCard: {
    flex: 1, backgroundColor: C.bgCard, borderRadius: 16, padding: 16,
    marginHorizontal: 16, borderWidth: 1, borderColor: C.border,
  },
  logHeaderRow: { marginBottom: 8 },
  logBadge: { fontSize: 11, color: C.textMuted, fontWeight: "700", letterSpacing: 1 },
  logScroll: { flex: 1 },
  logText: { fontSize: 12, lineHeight: 22, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },

  // ── Wallet Screen ──
  screenTitleStandalone: { fontSize: 20, fontWeight: "800", color: C.text, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  walletCard: {
    backgroundColor: C.bgCard, borderRadius: 16, padding: 20,
    marginHorizontal: 16, marginBottom: 16, alignItems: "center",
    borderWidth: 1, borderColor: C.border,
  },
  walletCardDot: { width: 12, height: 12, borderRadius: 6, marginBottom: 8 },
  walletStatus: { fontSize: 12, fontWeight: "800", color: C.textSec, letterSpacing: 2, marginBottom: 8 },
  walletAddress: {
    fontSize: 10, color: C.textMuted, textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", marginBottom: 16,
  },
  balanceBox: { alignItems: "center", marginBottom: 12 },
  balanceLabel: { fontSize: 11, color: C.textMuted, fontWeight: "600", letterSpacing: 1 },
  balanceValue: { fontSize: 24, fontWeight: "800", color: C.text },
  refreshBalText: { fontSize: 12, color: C.primary, fontWeight: "600" },
  walletHint: { fontSize: 13, color: C.textMuted, textAlign: "center", marginTop: 8 },

  connectBtn: {
    backgroundColor: C.primary, borderRadius: 14, paddingVertical: 16, alignItems: "center",
    marginHorizontal: 16, marginBottom: 12,
  },
  connectBtnText: { fontSize: 15, fontWeight: "800", color: "#fff", letterSpacing: 1 },
  disconnectBtn: {
    backgroundColor: "rgba(239,68,68,0.15)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
    borderRadius: 14, paddingVertical: 16, alignItems: "center",
    marginHorizontal: 16, marginBottom: 12,
  },
  disconnectBtnText: { fontSize: 14, fontWeight: "700", color: C.error },

  // ── Network Card ──
  networkCard: {
    backgroundColor: C.bgCard, borderRadius: 16, padding: 20,
    marginHorizontal: 16, borderWidth: 1, borderColor: C.border,
  },
  networkCardLabel: { fontSize: 11, fontWeight: "700", color: C.textMuted, letterSpacing: 2, marginBottom: 8 },
  networkRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  networkValue: { fontSize: 16, fontWeight: "700", color: C.text },
  networkLive: { width: 8, height: 8, borderRadius: 4 },
  networkRpc: { fontSize: 11, color: C.textMuted, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace", marginBottom: 16 },
  networkToggle: {
    backgroundColor: "rgba(139,92,246,0.12)", borderWidth: 1, borderColor: "rgba(139,92,246,0.3)",
    borderRadius: 10, paddingVertical: 10, alignItems: "center",
  },
  networkToggleText: { fontSize: 13, fontWeight: "700", color: C.primary },

  // ── Tab Bar ──
  tabBar: {
    flexDirection: "row", justifyContent: "space-around",
    borderTopWidth: 1, borderTopColor: C.border,
    backgroundColor: C.bg, paddingVertical: 8, paddingBottom: Platform.OS === "ios" ? 24 : 8,
  },
  tab: { alignItems: "center", paddingVertical: 6, flex: 1 },
  tabIcon: { fontSize: 20 },
  tabLabel: { fontSize: 10, fontWeight: "600", color: C.textMuted, marginTop: 2 },
  tabLabelActive: { color: C.primary },
  tabIndicator: { width: 20, height: 3, backgroundColor: C.primary, borderRadius: 2, marginTop: 4 },

  // ── Onboarding ──
  onboardingContainer: { flex: 1, backgroundColor: C.bg, justifyContent: "center", alignItems: "center", padding: 30, paddingTop: 60 },
  onboardingDots: { flexDirection: "row", gap: 8, marginBottom: 24 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.15)" },
  dotActive: { backgroundColor: C.primary, width: 24 },
  onboardingCard: {
    backgroundColor: C.bgCard, borderRadius: 20, padding: 24, width: "100%",
    borderWidth: 1, borderColor: C.border,
  },
  onboardingStep: { fontSize: 36, fontWeight: "900", color: C.primary, marginBottom: 4 },
  onboardingTitle: { fontSize: 20, fontWeight: "800", color: C.text, marginBottom: 4 },
  onboardingSubtitle: { fontSize: 14, color: C.textMuted, marginBottom: 16 },
  onboardingDivider: { height: 1, backgroundColor: C.border, marginBottom: 16 },
  onboardingItem: { fontSize: 13, color: C.textSec, lineHeight: 24 },
  onboardingNav: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    width: "100%", marginTop: 24,
  },
  onboardingBack: { fontSize: 14, color: C.textMuted, fontWeight: "600" },
  onboardingNextBtn: { backgroundColor: C.primary, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14 },
  onboardingNextText: { fontSize: 14, fontWeight: "800", color: "#fff", letterSpacing: 1 },
  onboardingSkip: { fontSize: 12, color: C.textMuted, marginTop: 24 },
});
