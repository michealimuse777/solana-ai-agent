import React, { useState } from 'react';
import { View, TextInput, Button, Text, Alert } from 'react-native';
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { Buffer } from 'buffer';
global.Buffer = Buffer; // Polyfill

const API_URL = "http://172.20.10.5:3000/agent/execute"; // TODO: Replace with your actual LAN IP if different
// 1. Point to Devnet
const SOLANA_RPC = "https://api.devnet.solana.com";

const connection = new Connection(SOLANA_RPC);

// 2. Configure Wallet Adapter (if using Mobile Wallet Adapter)
const APP_IDENTITY = {
  name: 'Solana AI Agent (Dev)',
  uri: 'https://your-app-url.com',
  icon: 'favicon.ico',
};

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState("");
  const [paymentSig, setPaymentSig] = useState(null);

  // Mock Wallet (Replace with Solana Mobile Wallet Adapter in Prod)
  // WARNING: Never store private keys in code. Use Phantom/Solflare deep links.

  const handleSend = async () => {
    try {
      setLogs("Thinking...");

      const headers = { "Content-Type": "application/json" };
      if (paymentSig) headers["X-Payment-Sig"] = paymentSig;

      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, user_pubkey: "11111111111111111111111111111111" })
      });

      // --- x402 PAYWALL LOGIC ---
      if (res.status === 402) {
        const payData = await res.json();
        setLogs(`Payment Required: ${payData.amount} lamports`);

        // Prompt user to pay (Mocking the payment here)
        // In real app: await transacationProvider.signAndSend(...)
        const fakeSig = "mock_devnet_signature";
        setPaymentSig(fakeSig);

        Alert.alert("Paywall", "Please pay 0.000005 SOL to proceed.");
        return;
      }

      // --- EXECUTE INTENT ---
      const data = await res.json();
      setLogs(data.message);

      if (data.tx_base64) {
        // Deserialize and Sign
        const txBuffer = Buffer.from(data.tx_base64, 'base64');
        const transaction = Transaction.from(txBuffer);

        // Sign with wallet (Phantom/SMS)
        // await signAndSend(transaction);
        setLogs("Transaction built! Ready to sign.");
      }

      else if (data.action_type === "MINT_NFT") {
        // Client Side Execution
        setLogs(`Minting NFT: ${data.meta.name}...`);
        // Call Umi / Metaplex JS SDK here
      }

    } catch (e) {
      console.log("FULL ERROR:", e);
      setLogs("Error: " + JSON.stringify(e, Object.getOwnPropertyNames(e)));
    }
  };

  return (
    <View style={{ padding: 50 }}>
      <Text style={{ fontWeight: 'bold', fontSize: 18, marginBottom: 10 }}>Solana AI Agent</Text>
      <Text style={{ fontSize: 10, color: '#666', marginBottom: 20 }}>Target: {API_URL}</Text>

      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        placeholder="E.g. Swap 0.1 SOL to USDC"
        style={{ borderWidth: 1, marginVertical: 10, padding: 10, borderRadius: 5 }}
      />
      <Button title="Execute" onPress={handleSend} />

      <Text style={{ marginTop: 20, fontWeight: 'bold' }}>Logs:</Text>
      <Text style={{ marginTop: 5, color: logs.includes("Error") ? 'red' : 'black' }}>{logs}</Text>
    </View>
  );
}
