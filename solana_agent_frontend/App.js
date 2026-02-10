import React, { useState, useCallback } from 'react';
import { View, TextInput, Button, Text, Alert, StyleSheet, ScrollView } from 'react-native';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
global.Buffer = Buffer; // Polyfill

const API_URL = "http://172.20.10.5:3000/agent/execute";
const SOLANA_RPC = "https://api.devnet.solana.com";
const connection = new Connection(SOLANA_RPC);

const APP_IDENTITY = {
  name: 'Solana AI Agent',
  uri: 'https://solana-ai-agent.dev',
  icon: 'favicon.ico',
};

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState("Ready. Connect wallet & enter a command.");
  const [paymentSig, setPaymentSig] = useState(null);
  const [walletAddress, setWalletAddress] = useState(null);

  // ─── CONNECT WALLET ───────────────────────────────────────
  const connectWallet = useCallback(async () => {
    try {
      setLogs("Connecting to wallet...");
      await transact(async (wallet) => {
        const authResult = await wallet.authorize({
          cluster: 'devnet',
          identity: APP_IDENTITY,
        });
        const pubkey = new PublicKey(authResult.accounts[0].address);
        setWalletAddress(pubkey.toBase58());
        setLogs(`Wallet connected: ${pubkey.toBase58().slice(0, 8)}...`);
      });
    } catch (e) {
      console.log("Wallet connect error:", e);
      setLogs("Wallet connection failed: " + e.message);
    }
  }, []);

  // ─── SIGN AND SEND TRANSACTION ────────────────────────────
  const signAndSendTx = useCallback(async (txBase64) => {
    try {
      setLogs("Requesting wallet signature...");
      const txBuffer = Buffer.from(txBase64, 'base64');

      await transact(async (wallet) => {
        // Re-authorize (session may have expired)
        const authResult = await wallet.authorize({
          cluster: 'devnet',
          identity: APP_IDENTITY,
        });

        // Try to deserialize as a regular Transaction first
        let tx;
        try {
          tx = Transaction.from(txBuffer);
          // Set recent blockhash
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.feePayer = new PublicKey(authResult.accounts[0].address);
        } catch {
          // Fallback to VersionedTransaction
          tx = VersionedTransaction.deserialize(txBuffer);
        }

        // Sign and send via wallet
        const signed = await wallet.signAndSendTransactions({
          transactions: [tx],
        });

        const sig = signed[0]; // Transaction signature
        setLogs(`✅ Transaction sent!\nSignature: ${sig}`);
      });
    } catch (e) {
      console.log("Sign/Send error:", e);
      setLogs("Transaction failed: " + e.message);
    }
  }, []);

  // ─── MAIN HANDLER ─────────────────────────────────────────
  const handleSend = async () => {
    try {
      const currentPubkey = walletAddress || "11111111111111111111111111111111";
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
        setLogs(`Payment Required: ${payData.amount} lamports`);

        if (walletAddress) {
          // Real payment flow: sign a real transaction to merchant
          Alert.alert("Paywall", "Real payment not yet implemented. Using mock.");
        }

        // Mock payment for dev
        const fakeSig = "mock_devnet_signature";
        setPaymentSig(fakeSig);
        Alert.alert("Paywall", "Mock payment set. Click Execute again.");
        return;
      }

      // ── PROCESS RESPONSE ──
      const data = await res.json();
      setLogs(data.message);

      // SWAP or TRANSFER: Sign the transaction
      if (data.tx_base64) {
        if (walletAddress) {
          // Real signing with wallet
          await signAndSendTx(data.tx_base64);
        } else {
          setLogs(data.message + "\n\n⚠️ Connect wallet first to sign & send!");
        }
      }

      // MINT NFT: Client-side execution
      else if (data.action_type === "MINT_NFT") {
        setLogs(`Minting NFT: ${data.meta.name}...\n(Metaplex Umi integration coming soon)`);
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
          {walletAddress ? `🟢 ${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}` : '🔴 No Wallet'}
        </Text>
        <Button
          title={walletAddress ? "Connected" : "Connect Wallet"}
          onPress={connectWallet}
          color={walletAddress ? "#4CAF50" : "#2196F3"}
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
      <Text style={[styles.logText, { color: logs.includes("Error") || logs.includes("failed") ? 'red' : logs.includes("✅") ? 'green' : '#333' }]}>
        {logs}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 40, paddingTop: 60, backgroundColor: '#f8f9fa' },
  title: { fontWeight: 'bold', fontSize: 22, marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#999', marginBottom: 16 },
  walletBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, padding: 10, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e0e0e0' },
  walletText: { fontSize: 13, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#ccc', marginVertical: 10, padding: 12, borderRadius: 8, backgroundColor: '#fff', fontSize: 15 },
  logLabel: { marginTop: 20, fontWeight: 'bold', fontSize: 14 },
  logText: { marginTop: 8, fontSize: 13, lineHeight: 20 },
});
