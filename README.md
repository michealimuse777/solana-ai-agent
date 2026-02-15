# Solana AI Agent (Hybrid Architecture)

A production-grade "Hybrid" AI Agent on Solana. Interact with the blockchain using natural language commands.

## Live Demo & Download

| Platform | Link | Notes |
| :--- | :--- | :--- |
| **Web App** | [**Launch App**](https://solana-agent-v3.surge.sh) | Works on iOS via Safari & Desktop. Supports deep-linking with Phantom. |
| **Android** | [**Download APK**](https://expo.dev/accounts/imusemicheal777/projects/solana_agent_frontend/builds/fec229da-a3a4-4488-880c-681d126de63b) | Direct APK install. |
| **iOS** | [**Use Web App**](https://solana-agent-v3.surge.sh) | Recommended for iOS users (PWA). Native iOS requires TestFlight/Team invite. |

---

## Project Overview

This is a **non-custodial AI-powered wallet interface** for Solana. Instead of navigating complex blockchain UIs, users type natural language commands (e.g., "Send 0.1 SOL to Alice"), and an AI agent interprets them into executable transactions.

### Key Features
1.  **AI Command Interpretation**: Uses advanced Natural Language Processing to extract intent (Transfer, Swap, Mint), amounts, tokens, and recipients from raw text.
2.  **Smart Execution**: Integrates with Jupiter Aggregator for best-price swaps and handles SPL token transfers natively.
3.  **Non-Custodial Security**: Private keys never leave the user's wallet (Phantom). The agent constructs transactions, but the user must sign them in their own wallet app.
4.  **Context-Aware UI**: The interface adapts in real-time, showing parsing progress, transaction simulation details, and success/failure feedback using a clean, modern design system.

---

## Technology Stack

### Frontend (Mobile & Web)
*   **Framework**: React Native / Expo (SDK 54)
*   **Language**: JavaScript / React
*   **Styling**: Custom Design System (Glassmorphism aesthetics, StyleSheet API)
*   **Wallet Integration**: Phantom Deep Links (using `nacl` for shared-secret encryption)
*   **Web Compatibility**: `react-native-web` with `localStorage` persistence for session management

### Backend (AI & Blockchain Logic)
*   **Language**: Rust
*   **Web Framework**: Axum (High-performance async server)
*   **AI Engine**: LLM Integration (Google Gemini 1.5 Flash via API)
*   **Blockchain Interaction**: `solana-client`, `solana-sdk`, `spl-token` crates
*   **DEX Aggregator**: Jupiter Swap API (v6) integration for optimal routing
*   **Deployment**: Render (Web Service) running on Linux

---

## Architecture Flow

1.  **User Input**: User types a command in the frontend.
2.  **Intent Parsing**: Frontend sends text to the Backend.
3.  **AI Processing (LLM)**: Backend sends prompt to LLM to extract structured data (Action, Token, Amount).
4.  **Transaction Build**: Backend fetches blockhash, token data, or swap routes (Jupiter) and constructs a serialized transaction.
5.  **User Review**: Frontend displays an "Interpretation Card" showing the proposed action.
6.  **Signing**: User clicks "Execute", triggering a deep link to Phantom Wallet.
7.  **On-Chain Execution**: User signs in Phantom, and the transaction is broadcast to Solana.

---

## Roadmap

*   [ ] **Voice Command Interface**: Speak to execute transactions.
*   [ ] **Transaction History**: Searchable log of past actions.
*   [ ] **Portfolio Analytics**: Visual breakdown of assets.
*   [ ] **Automated Actions**: DCA and scheduled payments.
*   [ ] **Multi-Wallet Support**: Manage multiple wallets.

---

## Setup & Development

See [walkthrough.md](walkthrough.md) for detailed implementation notes.

### Quick Start

**Backend**:
```bash
cd solana_agent_backend
# Set up .env
cargo run
```

**Frontend**:
```bash
cd solana_agent_frontend
npx expo start
```
