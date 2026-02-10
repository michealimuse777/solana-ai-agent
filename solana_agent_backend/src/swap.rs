use serde_json::json;
use reqwest::Client;
use solana_sdk::{
    pubkey::Pubkey, system_instruction, transaction::Transaction, message::Message
};
use std::str::FromStr;

// Fetch Swap Transaction from Jupiter API v6
pub async fn get_jupiter_swap(input: &str, output: &str, amount: f64, user: &str) -> Result<String, String> {
    let client = Client::new();
    
    // 1. Map symbols to Mints (Simplified map)
    let input_mint = match input {
        "SOL" => "So11111111111111111111111111111111111111112",
        "USDC" => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        _ => return Err("Unknown Token".into()),
    };
    let output_mint = match output {
        "SOL" => "So11111111111111111111111111111111111111112",
        "USDC" => "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        _ => return Err("Unknown Token".into()),
    };

    // 2. Get Quote
    // Amount in Lamports/Atomic units (assuming 9 decimals for SOL, 6 for USDC - simplified)
    let amount_atomic = (amount * 1_000_000_000.0) as u64; 
    let quote_url = format!("https://quote-api.jup.ag/v6/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50", 
        input_mint, output_mint, amount_atomic);

    let quote_res = client.get(&quote_url).send().await.map_err(|_| "Quote Failed")?;
    let quote_json: serde_json::Value = quote_res.json().await.map_err(|_| "Quote JSON Bad")?;

    // 3. Get Swap Transaction
    let swap_req = json!({
        "quoteResponse": quote_json,
        "userPublicKey": user,
        "wrapAndUnwrapSol": true
    });

    let swap_res = client.post("https://quote-api.jup.ag/v6/swap")
        .json(&swap_req)
        .send().await.map_err(|_| "Swap API Failed")?;
    
    let swap_data: serde_json::Value = swap_res.json().await.map_err(|_| "Swap JSON Bad")?;
    
    Ok(swap_data["swapTransaction"].as_str().unwrap().to_string())
}

use base64::{engine::general_purpose, Engine as _};

// Build Native SOL Transfer
pub fn build_transfer_sol(from: &str, to: &str, amount: f64) -> Result<String, String> {
    let from_pub = Pubkey::from_str(from).map_err(|e| format!("Invalid from pubkey: {}", e))?;
    let to_pub = Pubkey::from_str(to).unwrap_or(from_pub); // Fallback to self if bad address
    let lamports = (amount * 1_000_000_000.0) as u64;

    let ix = system_instruction::transfer(&from_pub, &to_pub, lamports);
    let msg = Message::new(&[ix], Some(&from_pub));
    let tx = Transaction::new_unsigned(msg);
    
    Ok(general_purpose::STANDARD.encode(bincode::serialize(&tx).unwrap()))
}

pub fn build_mock_swap_tx(user: &str) -> Result<String, String> {
    // Self-transfer 1000 lamports (0.000001 SOL) to simulate a transaction
    build_transfer_sol(user, user, 0.000001)
}
