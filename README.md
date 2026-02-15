# Solana AI Agent (Hybrid Architecture)

A production-grade "Hybrid" AI Agent on Solana. Interact with the blockchain using natural language.

## 🚀 Live Demo & Download

| Platform | Link | Notes |
| :--- | :--- | :--- |
| **🌐 Web App** | [**Launch App**](https://solana-agent-v3.surge.sh) | Works on **iOS via Safari** & Desktop. Supports deep-linking with Phantom. |
| **🤖 Android** | [**Download APK**](https://expo.dev/accounts/imusemicheal777/projects/solana_agent_frontend/builds/fec229da-a3a4-4488-880c-681d126de63b) | Direct APK install. |
| **📱 iOS** | [**Use Web App**](https://solana-agent-v3.surge.sh) | Recommended for iOS users (PWA). Native iOS requires TestFlight/Team invite. |

---

## 🗺️ Roadmap & Future Features

- [ ] **Voice Command Interface**: Speak to execute transactions ("Send 5 SOL to Alice").
- [ ] **Transaction History**: Searchable, human-readable log of past actions.
- [ ] **Portfolio Analytics**: Visual breakdown of assets and performance.
- [ ] **Automated Actions**: DCA (Dollar Cost Averaging) and scheduled payments.
- [ ] **Multi-Wallet Support**: Manage multiple wallets simultaneously.

---

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
