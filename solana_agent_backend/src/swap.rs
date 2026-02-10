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

// ─── SPL TOKEN SUPPORT ──────────────────────────────────────

/// Map token symbols to their Solana mint addresses
/// Returns None for SOL (native, no mint), Some(mint) for SPL tokens
pub fn token_mint(symbol: &str) -> Option<&'static str> {
    match symbol.to_uppercase().as_str() {
        "SOL" => None, // Native SOL, no mint
        "USDC" => Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        "USDT" => Some("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
        "BONK" => Some("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
        "JUP"  => Some("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
        "RAY"  => Some("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"),
        "WIF"  => Some("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"),
        _ => None,
    }
}

/// Get decimal places for a token (for converting human-readable amounts to atomic units)
pub fn token_decimals(symbol: &str) -> u8 {
    match symbol.to_uppercase().as_str() {
        "SOL"  => 9,
        "USDC" => 6,
        "USDT" => 6,
        "BONK" => 5,
        "JUP"  => 6,
        "RAY"  => 6,
        "WIF"  => 6,
        _ => 9, // Default to 9 (SOL-like)
    }
}

/// Build an SPL token transfer transaction
/// Uses create_associated_token_account_idempotent (safe if ATA already exists)
pub fn build_transfer_spl(
    owner: &str,
    recipient: &str,
    mint_address: &str,
    amount_atomic: u64,
) -> Result<String, String> {
    use spl_token::instruction as token_ix;
    use spl_associated_token_account::{
        get_associated_token_address,
        instruction::create_associated_token_account_idempotent,
    };

    let owner_pub = Pubkey::from_str(owner)
        .map_err(|e| format!("Invalid owner pubkey: {}", e))?;
    let recipient_pub = Pubkey::from_str(recipient)
        .map_err(|e| format!("Invalid recipient pubkey: {}", e))?;
    let mint_pub = Pubkey::from_str(mint_address)
        .map_err(|e| format!("Invalid mint address: {}", e))?;

    let owner_ata = get_associated_token_address(&owner_pub, &mint_pub);
    let recipient_ata = get_associated_token_address(&recipient_pub, &mint_pub);

    let mut instructions = vec![];

    // Create recipient ATA if it doesn't exist (idempotent = safe to call even if exists)
    instructions.push(
        create_associated_token_account_idempotent(
            &owner_pub,      // payer
            &recipient_pub,  // wallet address
            &mint_pub,       // token mint
            &spl_token::id(),
        )
    );

    // Transfer tokens from owner's ATA to recipient's ATA
    instructions.push(
        token_ix::transfer(
            &spl_token::id(),
            &owner_ata,
            &recipient_ata,
            &owner_pub,
            &[],
            amount_atomic,
        ).map_err(|e| format!("Failed to build transfer ix: {}", e))?
    );

    let msg = Message::new(&instructions, Some(&owner_pub));
    let tx = Transaction::new_unsigned(msg);

    Ok(general_purpose::STANDARD.encode(
        bincode::serialize(&tx).map_err(|e| format!("Serialize error: {}", e))?
    ))
}
