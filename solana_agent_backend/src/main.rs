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

// --- MODULES (Inline for single-file copy/paste simplicity) ---
mod ai;
mod swap;
mod payment;

// --- SHARED STATE ---
#[derive(Clone)]
struct AppState {
    // Round-robin key rotation
    gemini_keys: Vec<String>,
    key_index: Arc<AtomicUsize>,
    rpc_url: String,
}

impl AppState {
    fn get_next_key(&self) -> String {
        let idx = self.key_index.fetch_add(1, Ordering::SeqCst);
        self.gemini_keys[idx % self.gemini_keys.len()].clone()
    }
}

#[tokio::main]
async fn main() {
    dotenv().ok();
    
    // Load Keys from .env
    let keys = vec![
        env::var("GEMINI_KEY_1").expect("KEY 1 Missing"),
        env::var("GEMINI_KEY_2").expect("KEY 2 Missing"),
        env::var("GEMINI_KEY_3").expect("KEY 3 Missing"),
    ];

    let state = AppState {
        gemini_keys: keys,
        key_index: Arc::new(AtomicUsize::new(0)),
        rpc_url: "https://api.devnet.solana.com".to_string(), // Use Devnet for testing
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods(Any);

    let app = Router::new()
        .route("/agent/execute", post(handle_execute))
        .layer(middleware::from_fn(payment::x402_middleware)) // The Paywall
        .layer(cors)
        .with_state(state);

    println!("🚀 Backend running on 0.0.0.0:3000");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// --- REQUEST/RESPONSE MODELS ---
#[derive(Deserialize, Debug)]
struct UserRequest {
    prompt: String,
    user_pubkey: String,
}

#[derive(Serialize)]
struct AgentResponse {
    action_type: String, // SWAP, MINT, TRANSFER
    tx_base64: Option<String>, // For Swaps/Transfers
    meta: Option<serde_json::Value>, // For Mints (Client executes)
    message: String,
}

// --- MAIN HANDLER ---
async fn handle_execute(
    State(state): State<AppState>,
    Json(payload): Json<UserRequest>,
) -> impl IntoResponse {
    println!("Received: {}", payload.prompt);

    // 1. AI Parsing (Gemini)
    let intent = match ai::parse_intent(&state.get_next_key(), &payload.prompt).await {
        Ok(i) => i,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json_err(e.to_string()))).into_response(),
    };

    println!("Intent: {:?}", intent);

    // 2. Action Routing
    match intent.action.as_str() {
        "SWAP" => {
            // Devnet Mock Logic
            if state.rpc_url.contains("devnet") {
                let tx = swap::build_mock_swap_tx(&payload.user_pubkey);
                return (StatusCode::OK, Json(AgentResponse {
                    action_type: "SWAP".to_string(),
                    tx_base64: Some(tx),
                    meta: None,
                    message: "Devnet Mode: Returning Mock Swap Transaction (Self-Transfer)".to_string(),
                })).into_response();
            }

            // Call Jupiter API
            match swap::get_jupiter_swap(&intent.token_in, &intent.token_out, intent.amount, &payload.user_pubkey).await {
                Ok(tx) => (StatusCode::OK, Json(AgentResponse {
                    action_type: "SWAP".to_string(),
                    tx_base64: Some(tx),
                    meta: None,
                    message: format!("Swapping {} {} to {}", intent.amount, intent.token_in, intent.token_out),
                })).into_response(),
                Err(e) => (StatusCode::BAD_REQUEST, Json(json_err(e))).into_response(),
            }
        },
        "TRANSFER" => {
            // Build Native Transfer (Rust)
            // Note: Simplification - supports SOL only for now
            let tx = swap::build_transfer_sol(&payload.user_pubkey, &intent.recipient.unwrap(), intent.amount);
            (StatusCode::OK, Json(AgentResponse {
                action_type: "TRANSFER".to_string(),
                tx_base64: Some(tx),
                meta: None,
                message: format!("Sending SOL..."),
            })).into_response()
        },
        "MINT_NFT" => {
            // Return Metadata for Client-Side execution (Umi)
            // Why? Compiling Metaplex in Rust is heavy; JS is better for this specific task.
            (StatusCode::OK, Json(AgentResponse {
                action_type: "MINT_NFT".to_string(),
                tx_base64: None,
                meta: Some(serde_json::json!({
                    "name": intent.nft_name.unwrap_or("AI Gen".to_string()),
                    "symbol": "AI",
                    "uri": "https://arweave.net/placeholder" // You'd integrate Arweave upload here
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
