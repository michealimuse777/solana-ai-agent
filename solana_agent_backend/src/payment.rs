use axum::{
    body::Body, http::{Request, StatusCode}, middleware::Next, response::Response
};
use solana_client::rpc_client::RpcClient;
use std::str::FromStr;

const MERCHANT: &str = "YOUR_WALLET_ADDRESS"; 
const PRICE: u64 = 5000; // 5000 Lamports

pub async fn x402_middleware(req: Request<Body>, next: Next) -> Result<Response, StatusCode> {
    // 1. Check Custom Header for Transaction Signature
    if let Some(sig_val) = req.headers().get("X-Payment-Sig") {
        let sig_str = sig_val.to_str().map_err(|_| StatusCode::BAD_REQUEST)?;
        
        // 2. Verify On-Chain (Quick check)
        // In prod, use a cache to prevent re-using signatures!
        let rpc = RpcClient::new("https://api.mainnet-beta.solana.com".to_string());
        let sig = solana_sdk::signature::Signature::from_str(sig_str).map_err(|_| StatusCode::BAD_REQUEST)?;
        
        if rpc.get_transaction(&sig, solana_transaction_status::UiTransactionEncoding::Json).is_ok() {
            return Ok(next.run(req).await);
        }
    }

    // 3. Return 402 if unpaid
    let json_body = serde_json::json!({
        "error": "Payment Required",
        "address": MERCHANT,
        "amount": PRICE
    });

    Ok(Response::builder()
        .status(StatusCode::PAYMENT_REQUIRED)
        .header("Content-Type", "application/json")
        .body(Body::from(json_body.to_string()))
        .unwrap())
}
