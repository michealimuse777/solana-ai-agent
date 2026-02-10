# Solana AI Agent (Hybrid Architecture)

A production-grade "Hybrid" AI Agent on Solana.

## Architecture
- **Backend (`solana_agent_backend`)**: Rust (Axum) server handling AI intent (Gemini), Jupiter Swap API, and x402 payments.
- **Frontend (`solana_agent_frontend`)**: React Native (Expo) mobile app for wallet connection and signing.

## Setup
See [walkthrough.md](walkthrough.md) (if available) or individual READMEs in subdirectories.

### Quick Start
1. **Backend**:
   ```bash
   cd solana_agent_backend
   # Set up .env with GEMINI_KEY_1...
   cargo run
   ```

2. **Frontend**:
   ```bash
   cd solana_agent_frontend
   npx expo start
   ```
