# Project Overview - RetireFi (Investra)

## 1. Introduction & Purpose
**RetireFi / Investra (`tpjt-investra-src`)** is a Korean real-time stock market intelligence and theme observation dashboard designed for intraday momentum and leader stock (대장주) tracking. It aggregates, summarizes, and alerts on rapid price movements, volume surges, and market theme shifts using automated scraping and AI summarization.

## 2. System Architecture
The repository follows a clean layered structure separating external API scraping/adapters, core business service logic, REST API routers, and single-page web frontend rendering:

```
tpjt-investra-src/
├── adapter/                # External data fetching & integrating layer
│   ├── naver/              # Naver Finance & theme scraping
│   ├── toss_api/           # Toss Invest popular trading & ranking API client
│   ├── royalroader.py      # RoyalRoader momentum signals client
│   └── slack/              # Slack SDK integration for instant alerts
├── src/
│   ├── main.py             # FastAPI entry point and application initialization
│   ├── config/             # Pydantic environment configuration management
│   ├── application/
│   │   ├── api/            # REST API Router endpoints (market_router.py, etc.)
│   │   └── libs/market/    # Core analytical services (naver_theme_service.py, news_summarizer_service.py)
│   ├── static/
│   │   ├── css/style.css   # Custom Vanilla CSS design design tokens and responsive layout
│   │   └── js/main.js      # Frontend controller logic and DOM/Chart.js operations
│   └── templates/
│       └── index.html      # Primary Dashboard Single-Page UI
└── deploy/                 # Docker Compose configurations (Database, services)
```

## 3. Key Core Features & Data Domains
1. **전광판 매트릭스 (Grid View):** Real-time theme ranking displays. Computes leader stocks, top 5 sector movers, and intraday drawdown bands.
2. **대장주 주가 차트 (Leader Stock Chart View):** Renders interactive real-time price charts for sectoral leading stocks using Chart.js.
3. **종목 중심 압축 관찰판 (Consolidated Stock View):** A deduplicated table of leader stocks across all active themes. Calculates buy zone targets (1차 타점, 2차 타점) and monitors high-to-current drop percentages (고점대비 낙폭). Includes user custom alerts and Toss order shortcuts.
4. **🔥 상따 종목 (Limit-up Chasing - +24%↑):** Identifies rapid intraday gainers exceeding +24% across Naver, RoyalRoader, and Toss data sources. Features an in-place real-time updating mechanism ("눈고정 모드 ON") that stabilizes row positions during live tick updates for easy monitoring.
5. **AI 속보 브리핑 & 뉴스 요약:** Integrates LangChain/Ollama (`news_summarizer_service.py`) to distill breaking market financial news into actionable bullet points.

## 4. Backend & API Conventions
- **FastAPI:** All REST endpoints reside under `/api/v1/market/`.
- **Data Scraping & Caching:** Background scraping tasks run periodically (e.g., 30-minute theme summaries, intraday live refreshes) and serve JSON payloads directly to the responsive frontend.
