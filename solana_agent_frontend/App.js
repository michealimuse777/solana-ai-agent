import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import * as Linking from "expo-linking";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, ScrollView, Text, TextInput, View, StyleSheet, Alert } from "react-native";
import nacl from "tweetnacl";

global.Buffer = global.Buffer || Buffer;

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

  // ─── SIGN TRANSACTION (then send via RPC) ──────────────
  const signAndSendTx = async (txBase64) => {
    if (!session || !sharedSecret || !phantomWalletPublicKey) {
      addLog("⚠️ Connect wallet first!");
      return;
    }

    addLog("Building transaction for signing...");

    const txBuffer = Buffer.from(txBase64, "base64");
    const tx = Transaction.from(txBuffer);

    // Set recent blockhash and fee payer
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = phantomWalletPublicKey;

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
      addLog(`AI: ${data.message}`);

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
        addLog(`🎨 Minting: ${data.meta.name} (coming soon)`);
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
