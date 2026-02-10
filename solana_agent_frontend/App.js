import React, { useState, useEffect } from 'react';
import { View, TextInput, Button, Text, Alert, StyleSheet, ScrollView, Linking } from 'react-native';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import * as ExpoCrypto from 'expo-crypto';
global.Buffer = Buffer;

const API_URL = "http://172.20.10.5:3000/agent/execute";
const SOLANA_RPC = "https://api.devnet.solana.com";
const connection = new Connection(SOLANA_RPC);

// Phantom deep link config
const PHANTOM_CONNECT_URL = "https://phantom.app/ul/v1/connect";
const APP_URL = "solanaaiagent://"; // Our app's deep link scheme
const CLUSTER = "devnet";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState("Ready. Connect wallet & enter a command.");
  const [paymentSig, setPaymentSig] = useState(null);
  const [walletAddress, setWalletAddress] = useState(null);
  const [pendingTx, setPendingTx] = useState(null);

  // ─── LISTEN FOR PHANTOM DEEP LINK CALLBACKS ───────────────
  useEffect(() => {
    const handleDeepLink = (event) => {
      try {
        const url = new URL(event.url);
        const params = url.searchParams;

        // Handle connect callback
        if (url.pathname.includes('onConnect') || event.url.includes('onConnect')) {
          const pubkey = params.get('phantom_encryption_public_key') || params.get('public_key');
          if (pubkey) {
            setWalletAddress(pubkey);
            setLogs(`🟢 Wallet connected: ${pubkey.slice(0, 8)}...`);
          }
        }

        // Handle sign callback
        if (url.pathname.includes('onSign') || event.url.includes('onSign')) {
          const sig = params.get('signature');
          if (sig) {
            setLogs(`✅ Transaction signed!\nSignature: ${sig}`);
          }
        }
      } catch (e) {
        console.log("Deep link parse error:", e);
      }
    };

    const subscription = Linking.addEventListener('url', handleDeepLink);
    return () => subscription?.remove();
  }, []);

  // ─── CONNECT WALLET (Phantom Deep Link) ───────────────────
  const connectWallet = async () => {
    try {
      setLogs("Opening Phantom...");

      // Check if Phantom is installed
      const phantomInstalled = await Linking.canOpenURL("phantom://");
      if (!phantomInstalled) {
        Alert.alert(
          "Phantom Not Found",
          "Please install Phantom wallet from the App Store.",
          [{ text: "OK" }]
        );
        setLogs("⚠️ Phantom not installed. Using demo mode.");
        // Demo mode: use a placeholder address
        setWalletAddress("DEMO_MODE");
        return;
      }

      // Open Phantom connect
      const connectUrl = `${PHANTOM_CONNECT_URL}?app_url=${encodeURIComponent(APP_URL)}&cluster=${CLUSTER}&redirect_link=${encodeURIComponent(APP_URL + "onConnect")}`;
      await Linking.openURL(connectUrl);

    } catch (e) {
      console.log("Connect error:", e);
      // Fallback: demo mode
      setWalletAddress("DEMO_MODE");
      setLogs("Using Demo Mode (no wallet app detected).");
    }
  };

  // ─── MAIN HANDLER ─────────────────────────────────────────
  const handleSend = async () => {
    try {
      const currentPubkey = (walletAddress && walletAddress !== "DEMO_MODE")
        ? walletAddress
        : "11111111111111111111111111111111";

      setLogs("Thinking...");

      const headers = { "Content-Type": "application/json" };
      if (paymentSig) headers["X-Payment-Sig"] = paymentSig;

      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, user_pubkey: currentPubkey })
      });

      // ── x402 PAYWALL ──
      if (res.status === 402) {
        const payData = await res.json();
        setLogs(`💰 Payment Required: ${payData.amount} lamports`);
        const fakeSig = "mock_devnet_signature";
        setPaymentSig(fakeSig);
        Alert.alert("Paywall", "Mock payment set. Click Execute again.");
        return;
      }

      // ── PROCESS RESPONSE ──
      const data = await res.json();
      setLogs(data.message);

      // SWAP or TRANSFER
      if (data.tx_base64) {
        setPendingTx(data.tx_base64);

        if (walletAddress && walletAddress !== "DEMO_MODE") {
          // Try to open Phantom for signing
          try {
            const txBuffer = Buffer.from(data.tx_base64, 'base64');
            const tx = Transaction.from(txBuffer);
            const { blockhash } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = new PublicKey(walletAddress);

            const serialized = tx.serialize({ requireAllSignatures: false });
            const b64Tx = Buffer.from(serialized).toString('base64');

            const signUrl = `phantom://v1/signAndSendTransaction?transaction=${encodeURIComponent(b64Tx)}&cluster=${CLUSTER}&redirect_link=${encodeURIComponent(APP_URL + "onSign")}`;
            await Linking.openURL(signUrl);
            setLogs("📱 Phantom opened for signing...");
          } catch (signErr) {
            setLogs(data.message + "\n\n⚠️ Could not open Phantom: " + signErr.message);
          }
        } else {
          setLogs(data.message + "\n\n📋 Transaction ready (base64):\n" + data.tx_base64.slice(0, 40) + "...\n\n⚠️ Connect wallet to sign & send!");
        }
      }

      // MINT NFT
      else if (data.action_type === "MINT_NFT") {
        setLogs(`🎨 Minting NFT: ${data.meta.name}\n(Metaplex integration coming soon)`);
      }

    } catch (e) {
      console.log("FULL ERROR:", e);
      setLogs("Error: " + JSON.stringify(e, Object.getOwnPropertyNames(e)));
    }
  };

  // ─── UI ───────────────────────────────────────────────────
  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Solana AI Agent</Text>
      <Text style={styles.subtitle}>Target: {API_URL}</Text>

      {/* Wallet Status */}
      <View style={styles.walletBar}>
        <Text style={styles.walletText}>
          {walletAddress
            ? walletAddress === "DEMO_MODE"
              ? '🟡 Demo Mode'
              : `🟢 ${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}`
            : '🔴 No Wallet'}
        </Text>
        <Button
          title={walletAddress ? (walletAddress === "DEMO_MODE" ? "Demo" : "Connected") : "Connect Wallet"}
          onPress={connectWallet}
          color={walletAddress ? (walletAddress === "DEMO_MODE" ? "#FF9800" : "#4CAF50") : "#2196F3"}
        />
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
      <Text style={[styles.logText, {
        color: logs.includes("Error") || logs.includes("failed") ? '#e53935'
          : logs.includes("✅") ? '#2e7d32'
            : '#333'
      }]}>
        {logs}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 40, paddingTop: 60, backgroundColor: '#f8f9fa' },
  title: { fontWeight: 'bold', fontSize: 22, marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#999', marginBottom: 16 },
  walletBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 16, padding: 10, backgroundColor: '#fff',
    borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0'
  },
  walletText: { fontSize: 13, fontWeight: '600' },
  input: {
    borderWidth: 1, borderColor: '#ccc', marginVertical: 10,
    padding: 12, borderRadius: 8, backgroundColor: '#fff', fontSize: 15
  },
  logLabel: { marginTop: 20, fontWeight: 'bold', fontSize: 14 },
  logText: { marginTop: 8, fontSize: 13, lineHeight: 20 },
});
