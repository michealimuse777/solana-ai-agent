use serde_json::json;
use reqwest::Client;
use solana_sdk::{
    pubkey::Pubkey, system_instruction, transaction::Transaction, message::Message,
};
use std::str::FromStr;
use std::net::SocketAddr;
use base64::{engine::general_purpose, Engine as _};

// ═══════════════════════════════════════════════════════════════
// ─── TOKEN REGISTRY ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/// Map token symbols to their Solana mint addresses.
/// SOL uses the wrapped SOL mint for Jupiter compatibility.
pub fn token_mint(symbol: &str) -> Option<&'static str> {
    match symbol.to_uppercase().as_str() {
        "SOL"  => Some("So11111111111111111111111111111111111111112"),
        "USDC" => Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        "USDT" => Some("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
        "BONK" => Some("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
        "JUP"  => Some("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
        "RAY"  => Some("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"),
        "WIF"  => Some("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"),
        _ => None,
    }
}

/// Get decimal places for a token
pub fn token_decimals(symbol: &str) -> u8 {
    match symbol.to_uppercase().as_str() {
        "SOL"  => 9,
        "USDC" => 6,
        "USDT" => 6,
        "BONK" => 5,
        "JUP"  => 6,
        "RAY"  => 6,
        "WIF"  => 6,
        _ => 9,
    }
}

/// Validate that a token symbol is supported
pub fn is_valid_token(symbol: &str) -> bool {
    token_mint(symbol).is_some()
}

// ═══════════════════════════════════════════════════════════════
// ─── DNS-OVER-HTTPS RESOLVER ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/// Resolve a hostname via Google DNS-over-HTTPS.
/// This bypasses broken local DNS (e.g. mobile hotspots that can't resolve certain domains).
async fn resolve_via_doh(hostname: &str) -> Result<SocketAddr, String> {
    let doh_url = format!("https://dns.google/resolve?name={}&type=A", hostname);

    // Use a bare client (no custom DNS needed for dns.google - it resolves fine)
    let doh_client = Client::builder()
        .build()
        .map_err(|e| format!("DoH client error: {}", e))?;

    let resp = doh_client.get(&doh_url)
        .send().await
        .map_err(|e| format!("DoH request failed: {}", e))?;

    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("DoH parse error: {}", e))?;

    // Extract first A record IP from the Answer section
    if let Some(answers) = body["Answer"].as_array() {
        for answer in answers {
            if answer["type"].as_u64() == Some(1) { // Type A = 1
                if let Some(ip_str) = answer["data"].as_str() {
                    let addr: SocketAddr = format!("{}:443", ip_str)
                        .parse()
                        .map_err(|e| format!("IP parse error: {}", e))?;
                    return Ok(addr);
                }
            }
        }
    }

    Err(format!("Could not resolve {} via DNS-over-HTTPS", hostname))
}

// ═══════════════════════════════════════════════════════════════
// ─── JUPITER V6 SWAP ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/// Fetch a swap transaction from Jupiter API (api.jup.ag).
/// Requires a free API key from portal.jup.ag (set JUPITER_API_KEY in .env).
pub async fn get_jupiter_swap(
    input: &str,
    output: &str,
    amount: f64,
    user: &str,
) -> Result<String, String> {
    let api_key = std::env::var("JUPITER_API_KEY")
        .unwrap_or_default();

    if api_key.is_empty() {
        return Err("JUPITER_API_KEY not set in .env. Get a free key at https://portal.jup.ag".to_string());
    }

    let client = Client::builder()
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // Resolve mints from symbol registry
    let input_mint = token_mint(input)
        .ok_or_else(|| format!("Unknown input token: '{}'. Supported: SOL, USDC, USDT, BONK, JUP, RAY, WIF", input))?;
    let output_mint = token_mint(output)
        .ok_or_else(|| format!("Unknown output token: '{}'. Supported: SOL, USDC, USDT, BONK, JUP, RAY, WIF", output))?;

    // Convert human amount to atomic units using proper decimals
    let decimals = token_decimals(input);
    let amount_atomic = (amount * 10f64.powi(decimals as i32)) as u64;

    // 1. Get Quote from api.jup.ag
    let quote_url = format!(
        "https://api.jup.ag/swap/v1/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
        input_mint, output_mint, amount_atomic
    );

    let quote_res = client.get(&quote_url)
        .header("x-api-key", &api_key)
        .send().await
        .map_err(|e| format!("Jupiter quote request failed: {}", e))?;

    if !quote_res.status().is_success() {
        let status = quote_res.status();
        let body = quote_res.text().await.unwrap_or_default();
        return Err(format!("Jupiter quote error ({}): {}", status, body));
    }

    let quote_json: serde_json::Value = quote_res.json().await
        .map_err(|e| format!("Jupiter quote parse error: {}", e))?;

    // Check for quote errors
    if let Some(err) = quote_json.get("error") {
        return Err(format!("Jupiter quote error: {}", err));
    }

    // 2. Get Swap Transaction (versioned tx - supports lookup tables, fits size limit)
    let swap_req = json!({
        "quoteResponse": quote_json,
        "userPublicKey": user,
        "wrapAndUnwrapSol": true
    });

    let swap_res = client.post("https://api.jup.ag/swap/v1/swap")
        .header("x-api-key", &api_key)
        .json(&swap_req)
        .send().await
        .map_err(|e| format!("Jupiter swap request failed: {}", e))?;

    if !swap_res.status().is_success() {
        let status = swap_res.status();
        let body = swap_res.text().await.unwrap_or_default();
        return Err(format!("Jupiter swap error ({}): {}", status, body));
    }

    let swap_data: serde_json::Value = swap_res.json().await
        .map_err(|e| format!("Jupiter swap parse error: {}", e))?;

    println!("[JUPITER] Response keys: {:?}", swap_data.as_object().map(|o| o.keys().collect::<Vec<_>>()));

    let swap_tx = swap_data["swapTransaction"].as_str()
        .ok_or("Jupiter response missing swapTransaction field")?;

    Ok(swap_tx.to_string())
}

// ═══════════════════════════════════════════════════════════════
// ─── FEE BUNDLING ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/// Append a small SOL fee transfer to an existing legacy transaction.
/// This lets the user sign once for both the swap AND the platform fee.
pub fn append_fee_to_tx(
    tx_base64: &str,
    user_pubkey: &str,
    fee_wallet: &str,
    fee_lamports: u64,
) -> Result<String, String> {
    // Skip if no fee configured
    if fee_lamports == 0 || fee_wallet.is_empty() {
        return Ok(tx_base64.to_string());
    }

    // Decode the transaction
    let tx_bytes = general_purpose::STANDARD.decode(tx_base64)
        .map_err(|e| format!("Failed to decode tx: {}", e))?;

    let mut tx: Transaction = bincode::deserialize(&tx_bytes)
        .map_err(|e| format!("Failed to deserialize tx: {}", e))?;

    // Build fee instruction
    let user_pub = Pubkey::from_str(user_pubkey)
        .map_err(|e| format!("Invalid user pubkey: {}", e))?;
    let fee_pub = Pubkey::from_str(fee_wallet)
        .map_err(|e| format!("Invalid fee wallet: {}", e))?;

    let fee_ix = system_instruction::transfer(&user_pub, &fee_pub, fee_lamports);

    // Add instruction to the message
    let mut account_keys = tx.message.account_keys.clone();

    // Check if fee wallet is already in account_keys
    let fee_idx = if let Some(idx) = account_keys.iter().position(|k| k == &fee_pub) {
        idx as u8
    } else {
        let idx = account_keys.len() as u8;
        account_keys.push(fee_pub);
        idx
    };

    // Find user (fee payer) index - should always be 0
    let user_idx = account_keys.iter().position(|k| k == &user_pub)
        .unwrap_or(0) as u8;

    // Find system program index
    let system_program = Pubkey::from_str("11111111111111111111111111111111").unwrap();
    let sys_idx = if let Some(idx) = account_keys.iter().position(|k| k == &system_program) {
        idx as u8
    } else {
        let idx = account_keys.len() as u8;
        account_keys.push(system_program);
        idx
    };

    // Build compiled instruction
    let compiled_fee_ix = solana_sdk::instruction::CompiledInstruction {
        program_id_index: sys_idx,
        accounts: vec![user_idx, fee_idx],
        data: fee_ix.data.clone(),
    };

    // Rebuild message with new instruction
    let mut instructions = tx.message.instructions.clone();
    instructions.push(compiled_fee_ix);

    let new_message = solana_sdk::message::Message {
        header: solana_sdk::message::MessageHeader {
            num_required_signatures: tx.message.header.num_required_signatures,
            num_readonly_signed_accounts: tx.message.header.num_readonly_signed_accounts,
            num_readonly_unsigned_accounts: tx.message.header.num_readonly_unsigned_accounts,
        },
        account_keys,
        recent_blockhash: tx.message.recent_blockhash,
        instructions,
    };

    tx.message = new_message;

    // Re-serialize
    Ok(general_purpose::STANDARD.encode(
        bincode::serialize(&tx).map_err(|e| format!("Serialize error: {}", e))?
    ))
}

// ═══════════════════════════════════════════════════════════════
// ─── BASIC TRANSACTIONS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/// Build native SOL transfer
pub fn build_transfer_sol(from: &str, to: &str, amount: f64) -> Result<String, String> {
    let from_pub = Pubkey::from_str(from).map_err(|e| format!("Invalid from pubkey: {}", e))?;
    let to_pub = Pubkey::from_str(to).unwrap_or(from_pub);
    let lamports = (amount * 1_000_000_000.0) as u64;

    let ix = system_instruction::transfer(&from_pub, &to_pub, lamports);
    let msg = Message::new(&[ix], Some(&from_pub));
    let tx = Transaction::new_unsigned(msg);

    Ok(general_purpose::STANDARD.encode(bincode::serialize(&tx).unwrap()))
}

/// Build mock swap (devnet self-transfer)
pub fn build_mock_swap_tx(user: &str) -> Result<String, String> {
    build_transfer_sol(user, user, 0.000001)
}

// ─── SPL TOKEN TRANSFER ─────────────────────────────────────

/// Build an SPL token transfer transaction
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

    instructions.push(
        create_associated_token_account_idempotent(
            &owner_pub,
            &recipient_pub,
            &mint_pub,
            &spl_token::id(),
        )
    );

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
