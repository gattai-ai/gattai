<div align="center">

<img src="frontend/public/logo_gattai.png" alt="GATTAI Logo" width="120" height="120" style="border-radius: 24px;" />

# GATTAI

**Separate machines. One formation.**

*Orchestrated multi-model intelligence settled on Robinhood Chain, powered by $GATTAI.*

[![Build](https://img.shields.io/badge/Build-CI%20green-22c55e?style=flat-square)](#)
[![Network](https://img.shields.io/badge/Network-Robinhood%20Chain%204663-orange?style=flat-square)](#smart-contracts--deployments)
[![Mainnet](https://img.shields.io/badge/Mainnet-Fase%201%20Live-22c55e?style=flat-square)](#smart-contracts--deployments)
[![Phase](https://img.shields.io/badge/Phase-1%20USDG%20Only-blue?style=flat-square)](#smart-contracts--deployments)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](#license--security)

[Formations](#core-formations) · [Tokenomics](#economic-engine--gattai-tokenomics) · [API](#developer-surface) · [Contracts](#smart-contracts--deployments) · [Setup](#quickstart--local-setup)

</div>

---

## ⚡ The Vision

GATTAI takes its name from the Japanese *合体* ("gattai") — the fusion of separate machines into a single, more powerful form. Rather than forcing users to pick one AI model and accept its blind spots, every prompt in GATTAI triggers a coordinated **formation**: a pipeline of specialized models that each play a distinct role, passing structured context between them.

- **No single model wins everywhere.** GPT architects the brief; Claude executes and writes; Perplexity searches the live web; Higgsfield renders cinematic media.
- **One key, one credit balance.** A single API key covers all model usage. Credits are accounted as integer micro-credits (`1 credit = $0.01`), avoiding floating-point drift.
- **On-chain settlement.** Deposits are indexed on Robinhood Chain (Arbitrum Orbit L2). Automated token buy-back/burn is a planned, gated feature — not live in Phase 1.

---

## 🧩 Core Formations

Each formation is a declarative **Recipe** defined in `backend/config/recipes.yaml`. Models receive structured briefs from upstream steps and pass their output downstream.

```
[ User Prompt ]
      │
      ▼
 Step 1 — Interpret / Draft
      │ (structured brief)
      ▼
 Step 2 — Review / Execute
      │ (verified output)
      ▼
 Step 3 — Fix / Stream → [ User ]
```

| Formation | Steps | Output | Mode |
|---|---|---|---|
| **Refine** *(default)* | GPT `interpret` → Claude `execute` | Streaming text / code | `streaming` |
| **Code** | Claude `write` → GPT `review` → Claude `fix` | Streaming production code | `streaming` |
| **Research** | Perplexity `gather_sources` → Claude `write` | Cited synthesis report | `streaming` |
| **Visual** | Claude `art_direction` → Higgsfield `render` | Ultra-HD image asset | `async` |
| **Video** | Claude `script_and_shots` → Higgsfield `render` | Cinematic MP4 clip | `async` |
| **Launch Kit** | Claude `copy_pack` → Higgsfield `render_banner` | Multi-asset bundle | `mixed` |

> **Smart Pass-Through** — trivial inputs (e.g. greetings) trigger `pass_through: true` in the interpreter, skipping unnecessary steps to reduce latency and credit cost.

The `/chat/completions` endpoint accepts `gattai/refine`, `gattai/research`, and `gattai/code`. Visual, Video, and Launch Kit run as async jobs via `POST /v1/runs`.

---

## 🔥 Economic Engine & $GATTAI Tokenomics

All monetary values are stored as **integer micro-credits** to prevent floating-point rounding errors.

```
1 credit        = $0.01 USD
1 micro-credit  = 1/1,000,000 credit
1 USD           = 1×10⁸ micro-credits
```

When burn epochs are active, a configurable share of settled margin (`charged − provider_cost`) is routed to token buy-back and burn. The automated executor is not implemented; early epochs, if any, will be executed manually via Gnosis Safe.

```
[ User Run (AI inference) ]
           │
  margin = charged − provider_cost
           │
    ┌──────┴──────┐
    ▼             ▼
ETH / USDG    $GATTAI
30% of margin  50% of margin
→ DEX buyback  → Direct burn
  & burn         from Treasury
```

**Phase 1 scope:**

1. **USDG only.** ETH path exists in the contract (`nativeAccepted`) but is deployed with `nativeAccepted: false`. $GATTAI deposits and the TWAP discount remain disabled in Phase 1 even though the token is live on mainnet.
2. **15 % GATTAI discount** is configurable in the backend but inactive in Phase 1.
3. **Burn records** are indexed from onchain `Transfer` events to the dead address and exposed at `GET /v1/public/burns`. The response separates `team`, `epoch`, and `community` burns and includes exact base-unit strings.
4. **Public run shares** live at `/run/:slug`. The backend renders crawler-visible meta and a 1200×630 OG image, while `GET /v1/public/runs/:slug` exposes only the formation, optional prompt, output, public step labels, and charged cost. Wallet, balance, API key, provider cost, and internal IDs are never included.
5. **Weekly leaderboard** lives at `/leaderboard`. It ranks settled runs with a 200-run/project/day UTC cap, excludes team/treasury/internal wallets, shows the top 20, and exposes a private rank via `GET /v1/leaderboard/me`. Projects can opt out without exposing wallets or internal IDs.
6. **Public stats** live at `/stats` and `GET /v1/public/stats`. It aggregates settled run usage, USDG deposit volume, settled credits/USD revenue, onchain burns (consistent with `/burns`), and smart contract paused status with Blockscout links.
7. **Holder Tiers** live at `/holders`. Wallet holders of $GATTAI receive daily free AI run quotas across three tiers (Pilot: 10k tokens → 5 runs/day, Commander: 50k tokens → 15 text + 1 media/day, Fleet Admiral: 250k tokens → 40 text + 5 media/day). Anti-dumping is enforced via 2-consecutive-snapshot verification ($\min(S_N, S_{N-1})$). Quotas reset at 00:00 UTC with a daily protocol budget cap and emergency kill-switch. Public tiers are exposed at `GET /v1/public/holder/tiers` and authenticated status at `GET /v1/holder/status`.

---

## 🛠 Developer Surface

GATTAI exposes an **OpenAI-compatible** `/v1/chat/completions` endpoint. Drop your API key into any SDK that supports a custom base URL.

**Streaming chat completion:**

```bash
curl https://www.gattai.tech/api/v1/chat/completions \
  -H "Authorization: Bearer gtt_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gattai/code",
    "messages": [
      { "role": "user", "content": "Write an ERC-721 staking vault with reentrancy protection." }
    ],
    "stream": true
  }'
```

**Available models (chat/completions):**

| Model | Formation |
|---|---|
| `gattai/refine` | Default — interpret then execute |
| `gattai/code` | Write → review → fix |
| `gattai/research` | Gather sources → write cited report |

**Async job endpoints (visual, video, launch kit):**

```
POST   /v1/runs                  Start an async formation job
GET    /v1/runs/:id/events       SSE stream — progress + token deltas
POST   /v1/runs/:id/share        Create/refresh a public run link
GET    /v1/public/runs/:slug     Read a shared run (no auth)
POST   /v1/deposits/confirm      Confirm an on-chain top-up
```

API key format: `gtt_live_...` — generated and hashed server-side; the prefix is stored for display.

---

## ⛓ Smart Contracts & Deployments

Contracts are verified on Robinhood Chain. Phase 1 runs **USDG-only** with native ETH deposits disabled (`nativeAccepted: false`).

### Mainnet (Robinhood Chain · Chain ID `4663`)

| Contract | Address | Notes |
|---|---|---|
| **DepositManager (Phase 1)** | [`0xbf1F9ea84820B619EdC58eD15304Eb22547fBC07`](https://explorer.chain.robinhood.com/address/0xbf1F9ea84820B619EdC58eD15304Eb22547fBC07) | Live deposit router. Forwards straight to treasury. `nativeAccepted: false` |
| **USDG** | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://explorer.chain.robinhood.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) | Allowlisted deposit asset (6 decimals) |
| **Treasury (Safe 2-of-3)** | [`0x5a777DAB051a2D05638b851330E7360C9333B905`](https://explorer.chain.robinhood.com/address/0x5a777DAB051a2D05638b851330E7360C9333B905) | Multi-sig receiver of all deposits |

### Testnet (Robinhood Testnet · Chain ID `46630`)

| Contract | Address | Notes |
|---|---|---|
| **DepositManager** | [`0x85052C5Add70D53c49C17519873dB5ECDaED1864`](https://explorer.testnet.chain.robinhood.com/address/0x85052C5Add70D53c49C17519873dB5ECDaED1864) | Testnet deployment |
| **MockUSDG** | [`0x9960A800CA3d007cd25b6756151bda71e5aEA936`](https://explorer.testnet.chain.robinhood.com/address/0x9960A800CA3d007cd25b6756151bda71e5aEA936) | Testnet mock (6 decimals) |
| **Treasury (Safe 2-of-3)** | [`0xAeE68Aaa6315959D145Edd2D25877871362907bb`](https://explorer.testnet.chain.robinhood.com/address/0xAeE68Aaa6315959D145Edd2D25877871362907bb) | Testnet Safe |
| **GattaiToken (legacy)** | [`0x2Ccb82C778442Ee3d2c7e990A394E4A3d3C5B970`](https://explorer.testnet.chain.robinhood.com/address/0x2Ccb82C778442Ee3d2c7e990A394E4A3d3C5B970) | Legacy testnet token — not used in Phase 1 |

`DepositManager` inherits `Ownable`, `Pausable`, and `ReentrancyGuard` from OpenZeppelin 5.x. ERC-20 transfers use `SafeERC20`. Funds are forwarded directly to treasury within the same transaction; the contract maintains zero balance.

---

## 💻 Tech Stack & Architecture

```
gattai/
├── backend/     # Bun + Hono, Drizzle ORM, PostgreSQL 16, SSE orchestration engine
├── frontend/    # React 19, Vite (rolldown), TypeScript, wagmi v3, viem v2, TanStack Query
├── contracts/   # Hardhat 3, Solidity 0.8.34, OpenZeppelin 5.x, Ignition modules
└── shared/      # ABIs, address registry, chain definitions
```

| Layer | Key choices |
|---|---|
| **Runtime** | Bun 1.2+ with native TypeScript, `--watch` in dev |
| **API** | Hono micro-framework, Server-Sent Events for streaming |
| **Database** | PostgreSQL 16, Drizzle ORM, append-only credit ledger, `SELECT … FOR UPDATE` FIFO lot consumption |
| **Auth** | SIWE (Sign-In with Ethereum) — gas-free, wallet-native |
| **Web3** | wagmi v3 + viem v2, custom RPC error sanitization |
| **Contracts** | Hardhat 3 + Ignition, mainnet preflight script with automated gate checks |

---

## 🚀 Quickstart & Local Setup

**Prerequisites:**
- [Bun](https://bun.sh) v1.2+
- PostgreSQL 15+
- EVM-compatible browser wallet (MetaMask or Rabby)

```bash
# 1. Clone and install
git clone https://github.com/zanuaraldi/gattai.git
cd gattai
bun install

# 2. Configure environment
cp backend/.env.example backend/.env
# Fill in DATABASE_URL and AI provider credentials

# 3. Run database migrations
bun run --cwd backend db:migrate

# 4. Start backend  →  http://localhost:3000
bun run dev:backend

# 5. Start frontend  →  http://localhost:5173
bun run dev:frontend

# Optional: verify on-chain connectivity and RPC health
bun run --cwd backend doctor
```

---

## 🧪 Testing & Verification

```bash
# Full test suite (backend + frontend)
bun test

# Backend only
bun run --cwd backend test

# Offline end-to-end — full pipeline with mock providers, no real API calls
bun run --cwd backend e2e:offline

# TypeScript checks across all workspaces
bun run --cwd backend typecheck
bun run --cwd frontend typecheck
bun run --cwd contracts typecheck
```

CI runs on GitHub Actions on every push to `main` and every pull request, against a live PostgreSQL 16 service container.

---

## 📄 License & Security

**License:** MIT

**Security model:**
- `DepositManager` uses `ReentrancyGuard`, `Pausable`, and `SafeERC20` (OpenZeppelin 5.x).
- Funds are forwarded to the treasury multisig in the same transaction — the contract holds no balance.
- Treasury is a 2-of-3 Gnosis Safe on testnet.
- Backend API keys are hashed at rest; only the prefix is stored for display.
- SIWE provides gas-free, wallet-native authentication with no custodial credentials.
