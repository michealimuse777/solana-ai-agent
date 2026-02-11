use axum::{
    extract::{State, Json},
    http::StatusCode,
    routing::post,
    Router,
    response::IntoResponse,
    middleware,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use tower_http::cors::{Any, CorsLayer};
use dotenv::dotenv;
use std::env;

// --- MODULES ---
mod ai;
mod swap;
mod payment;

// --- SHARED STATE ---
#[derive(Clone)]
struct AppState {
    gemini_keys: Vec<String>,
    key_index: Arc<AtomicUsize>,
    fee_wallet: String,
    fee_lamports: u64,
}

impl AppState {
    fn get_next_key(&self) -> String {
        let idx = self.key_index.fetch_add(1, Ordering::SeqCst);
        self.gemini_keys[idx % self.gemini_keys.len()].clone()
    }
}

fn sanitize_key(key: String) -> String {
    key.trim().replace('\r', "").replace('\n', "")
}

#[tokio::main]
async fn main() {
    dotenv().ok();

    let keys = vec![
        sanitize_key(env::var("GEMINI_KEY_1").expect("KEY 1 Missing")),
        sanitize_key(env::var("GEMINI_KEY_2").expect("KEY 2 Missing")),
        sanitize_key(env::var("GEMINI_KEY_3").expect("KEY 3 Missing")),
    ];

    let fee_wallet = env::var("FEE_WALLET").unwrap_or_default();
    let fee_lamports: u64 = env::var("FEE_LAMPORTS")
        .unwrap_or("5000".to_string())
        .parse()
        .unwrap_or(5000);

    let state = AppState {
        gemini_keys: keys,
        key_index: Arc::new(AtomicUsize::new(0)),
        fee_wallet,
        fee_lamports,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods(Any);

    let app = Router::new()
        .route("/agent/execute", post(handle_execute))
        .layer(middleware::from_fn(payment::x402_middleware))
        .layer(cors)
        .with_state(state);

    println!("[SERVER] Backend running on 0.0.0.0:3000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// --- REQUEST/RESPONSE MODELS ---
#[derive(Deserialize, Debug)]
struct UserRequest {
    prompt: String,
    user_pubkey: String,
    #[serde(default = "default_network")]
    network: String,
}

fn default_network() -> String { "devnet".to_string() }

#[derive(Serialize)]
struct AgentResponse {
    action_type: String,
    tx_base64: Option<String>,
    meta: Option<serde_json::Value>,
    message: String,
}

// --- MAIN HANDLER ---
async fn handle_execute(
    State(state): State<AppState>,
    Json(payload): Json<UserRequest>,
) -> impl IntoResponse {
    println!("[REQ] prompt={} network={}", payload.prompt, payload.network);

    let is_devnet = payload.network != "mainnet";

    // 1. AI Parsing (Gemini)
    let intent = match ai::parse_intent(&state.get_next_key(), &payload.prompt).await {
        Ok(i) => i,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json_err(e.to_string()))).into_response(),
    };

    println!("[INTENT] {:?}", intent);

    // 2. Action Routing
    match intent.action.as_str() {
        "SWAP" => {
            // ── GUARDRAIL: Validate tokens ──
            if !swap::is_valid_token(&intent.token_in) {
                return (StatusCode::BAD_REQUEST, Json(json_err(
                    format!("Unknown input token '{}'. Supported: SOL, USDC, USDT, BONK, JUP, RAY, WIF", intent.token_in)
                ))).into_response();
            }
            if !swap::is_valid_token(&intent.token_out) {
                return (StatusCode::BAD_REQUEST, Json(json_err(
                    format!("Unknown output token '{}'. Supported: SOL, USDC, USDT, BONK, JUP, RAY, WIF", intent.token_out)
                ))).into_response();
            }

            // ── Devnet: Mock swap (self-transfer) ──
            if is_devnet {
                match swap::build_mock_swap_tx(&payload.user_pubkey) {
                    Ok(tx) => return (StatusCode::OK, Json(AgentResponse {
                        action_type: "SWAP".to_string(),
                        tx_base64: Some(tx),
                        meta: None,
                        message: format!("Devnet Mock: Swap {} {} -> {} (self-transfer)", intent.amount, intent.token_in, intent.token_out),
                    })).into_response(),
                    Err(e) => return (StatusCode::BAD_REQUEST, Json(json_err(e))).into_response(),
                }
            }

            // ── Mainnet: Real Jupiter swap ──
            match swap::get_jupiter_swap(&intent.token_in, &intent.token_out, intent.amount, &payload.user_pubkey).await {
                Ok(tx) => {
                    // Append fee if configured
                    let final_tx = swap::append_fee_to_tx(
                        &tx, &payload.user_pubkey, &state.fee_wallet, state.fee_lamports
                    ).unwrap_or(tx);

                    (StatusCode::OK, Json(AgentResponse {
                        action_type: "SWAP".to_string(),
                        tx_base64: Some(final_tx),
                        meta: None,
                        message: format!("Swapping {} {} to {}", intent.amount, intent.token_in, intent.token_out),
                    })).into_response()
                },
                Err(e) => (StatusCode::BAD_REQUEST, Json(json_err(e))).into_response(),
            }
        },
        "TRANSFER" => {
            let recipient = match &intent.recipient {
                Some(r) => r.clone(),
                None => return (StatusCode::BAD_REQUEST, Json(json_err("Missing recipient address".into()))).into_response(),
            };

            let token = intent.token_in.to_uppercase();

            // Native SOL transfer
            if token == "SOL" || token.is_empty() {
                match swap::build_transfer_sol(&payload.user_pubkey, &recipient, intent.amount) {
                    Ok(tx) => return (StatusCode::OK, Json(AgentResponse {
                        action_type: "TRANSFER".to_string(),
                        tx_base64: Some(tx),
                        meta: None,
                        message: format!("Sending {} SOL to {}...{}", intent.amount, &recipient[..4.min(recipient.len())], &recipient[recipient.len().saturating_sub(4)..]),
                    })).into_response(),
                    Err(e) => return (StatusCode::BAD_REQUEST, Json(json_err(e))).into_response(),
                }
            }

            // SPL Token transfer
            let mint_address = match swap::token_mint(&token) {
                Some(m) => m,
                None => return (StatusCode::BAD_REQUEST, Json(json_err(
                    format!("Unknown token '{}'. Supported: USDC, USDT, BONK, JUP, RAY, WIF", token)
                ))).into_response(),
            };

            // On devnet, mainnet mints don't exist - use mock
            if is_devnet {
                match swap::build_transfer_sol(&payload.user_pubkey, &payload.user_pubkey, 0.000001) {
                    Ok(tx) => return (StatusCode::OK, Json(AgentResponse {
                        action_type: "TRANSFER".to_string(),
                        tx_base64: Some(tx),
                        meta: None,
                        message: format!("Devnet Mock: {} {} transfer to {}...{}", intent.amount, token, &recipient[..4.min(recipient.len())], &recipient[recipient.len().saturating_sub(4)..]),
                    })).into_response(),
                    Err(e) => return (StatusCode::BAD_REQUEST, Json(json_err(e))).into_response(),
                }
            }

            // Mainnet: Real SPL transfer
            let decimals = swap::token_decimals(&token);
            let amount_atomic = (intent.amount * 10f64.powi(decimals as i32)) as u64;

            match swap::build_transfer_spl(
                &payload.user_pubkey,
                &recipient,
                mint_address,
                amount_atomic,
            ) {
                Ok(tx) => (StatusCode::OK, Json(AgentResponse {
                    action_type: "TRANSFER".to_string(),
                    tx_base64: Some(tx),
                    meta: None,
                    message: format!("Sending {} {} to {}...{}", intent.amount, token, &recipient[..4.min(recipient.len())], &recipient[recipient.len().saturating_sub(4)..]),
                })).into_response(),
                Err(e) => (StatusCode::BAD_REQUEST, Json(json_err(e))).into_response(),
            }
        },
        "MINT_NFT" => {
            (StatusCode::OK, Json(AgentResponse {
                action_type: "MINT_NFT".to_string(),
                tx_base64: None,
                meta: Some(serde_json::json!({
                    "name": intent.nft_name.unwrap_or("AI Gen".to_string()),
                    "symbol": "AI",
                    "uri": "https://arweave.net/placeholder"
                })),
                message: "Minting NFT...".to_string(),
            })).into_response()
        },
        _ => (StatusCode::BAD_REQUEST, Json(json_err("Unknown Action".into()))).into_response()
    }
}

fn json_err(msg: String) -> AgentResponse {
    AgentResponse { action_type: "ERROR".into(), tx_base64: None, meta: None, message: msg }
}
