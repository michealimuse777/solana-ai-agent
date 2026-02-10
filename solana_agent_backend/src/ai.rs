use serde::Deserialize;
use reqwest::Client;

#[derive(Deserialize, Debug)]
pub struct Intent {
    pub action: String, // SWAP, TRANSFER, MINT_NFT, LP
    pub amount: f64,
    pub token_in: String,
    pub token_out: String,
    pub recipient: Option<String>,
    pub nft_name: Option<String>,
}

pub async fn parse_intent(api_key: &str, prompt: &str) -> Result<Intent, Box<dyn std::error::Error>> {
    let client = Client::new();
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}", api_key);
    
    // Prompt Engineering: Force JSON output
    let sys_prompt = r#"
    You are a Solana Transaction Parser. Output strictly JSON. No markdown.
    Schema:
    {
      "action": "SWAP" | "TRANSFER" | "MINT_NFT",
      "amount": number (0 if not applicable),
      "token_in": "SOL" | "USDC" | "BONK" (default SOL),
      "token_out": "USDC" (target token),
      "recipient": "PubkeyString" (if transfer),
      "nft_name": "String" (if mint)
    }
    User: "Swap 1 SOL for USDC" -> {"action":"SWAP", "amount":1, "token_in":"SOL", "token_out":"USDC"}
    User: "Send 0.5 SOL to 8Xy..." -> {"action":"TRANSFER", "amount":0.5, "token_in":"SOL", "token_out":"", "recipient":"8Xy..."}
    "#;

    let body = serde_json::json!({
        "contents": [{
            "parts": [{ "text": format!("{}\nUser Input: {}", sys_prompt, prompt) }]
        }]
    });

    let res = client.post(url).json(&body).send().await?;
    let data: serde_json::Value = res.json().await?;
    
    // Extract and clean JSON
    let text = data["candidates"][0]["content"]["parts"][0]["text"].as_str().ok_or("No candidate")?;
    let clean_text = text.replace("json", "").replace("```", "").trim().to_string();
    
    let intent: Intent = serde_json::from_str(&clean_text)?;
    Ok(intent)
}
