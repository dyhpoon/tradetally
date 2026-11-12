# TradeTally - Trading Journal & Analytics Platform

[![Docker Pulls](https://img.shields.io/docker/pulls/potentialmidas/tradetally)](https://hub.docker.com/r/potentialmidas/tradetally)
[![License](https://img.shields.io/github/license/GeneBO98/tradetally)](https://github.com/GeneBO98/tradetally/blob/main/LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GeneBO98/tradetally)](https://github.com/GeneBO98/tradetally/releases)

**Dominate With Data**

<img alt="TradeTally dashboard" src=".github/assets/screenshots/dashboard.png" />

A comprehensive trading journal and analytics platform built with Vue.js frontend and Node.js backend. Track your trades, analyze performance, and gain insights into your trading patterns across multiple brokers.

## Quick Links

- **Live Demo**: [tradetally.io](https://tradetally.io)
- **Documentation**: [docs.tradetally.io](https://docs.tradetally.io)
- **Forum**: [forum.tradetally.io](https://forum.tradetally.io)
- **iOS App**: [Download Here](https://apps.apple.com/us/app/tradetally/id6748022992)
- **Docker Hub**: [potentialmidas/tradetally](https://hub.docker.com/r/potentialmidas/tradetally)

### Demo Account
- **Username**: demo@example.com
- **Password**: DemoUser25

## Major Features

### Trading Journal & Analysis
- **Multi-Broker Support** - Import trades from Lightspeed, Charles Schwab, ThinkorSwim, IBKR, E*TRADE, ProjectX
- **Options & Futures Trading** - Full support for options and futures contracts with specialized analytics
- **Real-time Market Data** - Live stock quotes and unrealized P&L tracking
- **Trade Visualization** - Interactive candlestick charts with entry/exit markers

### Analytics & Insights
- **AI-Powered Analytics** - Personalized trading recommendations through cloud, local, or authenticated Codex/Claude CLI providers
- **Advanced Charts** - Performance analysis by hold time, day of week, sector, and more
- **Behavioral Analytics** - Revenge trading detection and overconfidence tracking (Pro)
- **Health Tracking** - Correlate sleep, heart rate, and other health metrics with trading performance (Pro)

### Markets & Alerts
- **Watchlists** - Track favorite stocks with real-time prices and news (Pro)
- **Price Alerts** - Email and browser notifications for price targets (Pro)
- **News Integration** - Automatic news enrichment for traded symbols
- **Earnings Tracking** - Monitor upcoming earnings for watchlist symbols (Pro)

### Community & Gamification
- **Leaderboards** - Track achievements and compete with peers
- **Public Trades** - Share trades and learn from the community
- **Achievements System** - Unlock badges and track milestones
- **Forum Integration** - Join discussions at [forum.tradetally.io](https://forum.tradetally.io)

### Mobile App
- **iOS App** - Native iOS application available in app store
- Full feature parity with web application
- Optimized mobile trading journal experience
- Required for the health tracking feature

## Deployment Options

### SaaS Platform
Fully hosted solution at [tradetally.io](https://tradetally.io)

### Self-Hosted
Free, open-source deployment with all Pro features included. Perfect for:
- Privacy-conscious users
- Personal or team use
- Complete control over your data
- No subscription fees

**Note**: For full feature access (real-time quotes, advanced charts, sector analysis), a [Finnhub.io Basic plan](https://finnhub.io/pricing) is required. Free tier available with limitations.

**Logo fallbacks**: the logo fallbacks send ticker requests directly from the
browser to Parqet and FMP.

### Vercel + Neon (this fork)

The root `vercel.json` deploys the Vue frontend and Express API together using
[Vercel Services](https://vercel.com/docs/services), currently in Beta. Keep the
Vercel project Root Directory at the repository root and select Node.js 24.x.
Neon and **private** Vercel Blob stores must be connected to the project.
Use separate Blob stores and tokens for Production and Preview. A Neon preview
branch may copy production attachment references; shared storage would let a
preview deletion remove a production image. Copied images are not available in
the separate preview store unless deliberately copied there.

Configure these variables for each deployment environment:

| Variable | Value or purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection, supplied by the integration |
| `DATABASE_URL_UNPOOLED` | Direct connection used for build-time migrations |
| `BLOB_READ_WRITE_TOKEN` | Private Blob store token supplied by the integration |
| `JWT_SECRET` | Random secret of at least 32 bytes; use separate values for preview and production |
| `CRON_SECRET` | Random secret for authenticated image cleanup |
| `FRONTEND_URL` | Exact public origin of the deployment |
| `CORS_ORIGINS` | Optional comma-separated exact origins, such as a stable preview alias |
| `IMAGE_STORAGE_PROVIDER` / `VITE_IMAGE_STORAGE_PROVIDER` | `vercel-blob` |
| `IMAGE_STORAGE_ENV` | `production` or `preview`, matching the environment |
| `VITE_API_URL` | `/api` |
| `NODE_ENV` / `TRUST_PROXY` | `production` / `1` |
| `DB_POOL_SIZE` / `DB_CONNECTION_TIMEOUT` | `5` / `15000` |
| `DISABLE_BACKGROUND_JOBS` | `true` |
| `ENABLE_PRICE_MONITORING` / `ENABLE_BACKUP_SCHEDULER` | `false` |
| `BILLING_ENABLED` | `false` |
| `REGISTRATION_MODE` | `disabled` until the owner is ready to register |

Keep Vercel deployment protection enabled during setup. The first registered
TradeTally user becomes an administrator. Enable registration only for the owner's
protected setup session, then disable it again. The TradeTally login is separate
from Vercel and Neon accounts. No signup at tradetally.io is needed.

Each API build runs `backend/scripts/migrateVercel.js`; a failed migration fails
the deployment. Enable Neon preview branching to isolate preview data. Test a
preview before releasing production. `/api/ready` checks the database connection.

Screenshots upload directly to private Blob storage and are served through the
existing authorized image routes. A daily production cron removes abandoned
uploads older than an hour, at most 1,000 per run. Preview cleanup is manual via
the same authenticated endpoint. Finished images are not removed by this job.

Manual JSON backups use private Blob storage. They include image references,
**not image bytes**; preserve the Blob store separately when planning recovery.
The existing Docker deployment and local filesystem storage remain supported.

This serverless setup supports manual journaling, screenshots, trade statistics,
and bounded CSV imports. CSV requests must stay below Vercel's 4.5 MB limit and
imports have a four-minute cooperative deadline. A timeout can leave imported
rows: review them before retrying or split the file into smaller batches. Imports
are not durable across instance termination. Scheduled broker sync, price alerts,
background enrichment, automatic application backups and queued email delivery
(including password reset) are disabled. Market-data and AI features require
their own provider keys. Free-tier quotas still apply.

## Technology Stack

**Backend**: Node.js, Express, PostgreSQL
**Frontend**: Vue.js 3, Tailwind CSS, Pinia
**APIs**: Finnhub, Alpha Vantage, configurable AI providers
**Infrastructure**: Docker, Nginx

## Getting Started

For detailed installation and setup instructions, visit the [documentation site](https://docs.tradetally.io).

### Local Development

TradeTally requires Node.js 24.21.0 or newer and uses pnpm for dependency management. Docker and CI use Node.js 24.21.0. If you use nvm, run `nvm install` and `nvm use` from the repository root to select the version pinned in `.nvmrc`.

Install pnpm, then install dependencies from the repository root:

```bash
npm install -g pnpm@10.34.5
pnpm install
pnpm --dir backend run dev
pnpm --dir frontend run dev
```

### Quick Start with Docker

```bash
docker pull potentialmidas/tradetally:latest
docker run -d -p 80:80 potentialmidas/tradetally:latest
```

See the [Docker Deployment Guide](https://docs.tradetally.io/deployment/docker/) for production setup.

## Documentation

Comprehensive documentation is available at [docs.tradetally.io](https://docs.tradetally.io):

- [Installation Guide](https://docs.tradetally.io/getting-started/installation/)
- [Quick Start](https://docs.tradetally.io/getting-started/quick-start/)
- [API Configuration](https://docs.tradetally.io/getting-started/api-keys/)
- [Docker Deployment](https://docs.tradetally.io/deployment/docker/)
- [Importing Trades](https://docs.tradetally.io/usage/importing-trades/)
- [Feature Guides](https://docs.tradetally.io/features/)

## Community & Support

- **Forum**: Join the [TradeTally Discourse](https://forum.tradetally.io) - If you have a TradeTally.io account, you can login with those credentials
- **GitHub Issues**: Report bugs or request features
- **Documentation**: [docs.tradetally.io](https://docs.tradetally.io)
- **iOS TestFlight**: [Join the beta](https://testflight.apple.com/join/11shUY3t)

## Screenshots

**Analytics**

<img alt="Analytics overview" src=".github/assets/screenshots/analytics.png" />

**Trades**

<img alt="Trade list" src=".github/assets/screenshots/trades.png" />

**Trading Calendar**

<img alt="Trading calendar" src=".github/assets/screenshots/calendar.png" />

**Trading Journal**

<img alt="Trading journal" src=".github/assets/screenshots/journal.png" />

**Trade Management (R-Multiple)**

<img alt="Trade management R-multiple analysis" src=".github/assets/screenshots/trade-management.png" />

**Behavioral Analytics**

<img alt="Revenge trading detection" src=".github/assets/screenshots/behavioral-revenge.png" />
<img alt="Loss aversion analysis" src=".github/assets/screenshots/behavioral-loss.png" />
<img alt="Missed profit opportunities" src=".github/assets/screenshots/behavioral-missed.png" />

**Leaderboard & Achievements**

<img alt="Leaderboard" src=".github/assets/screenshots/leaderboard.png" />
<img alt="Achievements" src=".github/assets/screenshots/achievements.png" />

## Star History

[![TradeTally GitHub star history](.github/assets/star-history.svg)](https://github.com/GeneBO98/tradetally)

## License

This project is open source software.

## Support Development

Feel free to [throw me a couple of bucks](https://buymeacoffee.com/BrennonO) if you got some use out of this.
