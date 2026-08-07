# Domain & UI Architecture Guide

## 1. Frontend Architecture (Vanilla JS & CSS)
The dashboard UI relies on pure HTML5, custom CSS (`style.css`), and Vanilla JavaScript (`main.js`). This avoids heavy bundle runtimes (such as React or Webpack) and allows micro-optimized DOM updates when high-frequency financial tick data is refreshed.

### Core Visual Tokens (`style.css`)
- **Typography:** Uses modern fonts (Outfit, Pretendard, Inter) for clear numeric tables and ticker symbols.
- **Color Palette:** Curated palettes for high contrast financial visualization:
  - Up/Gainers (상승): Red tones (`#dc2626`, `.up`, `.cell-flash-up`).
  - Down/Losers (하락): Blue tones (`#2563eb`, `.down`, `.cell-flash-down`).
  - Dark mode and clean card borders with glassmorphism hover transitions.

## 2. Single-Page Tab View Management (`main.js` & `index.html`)
The main interface toggles between four core views via `switchMainView(viewType)`:
1. `'grid'`: `grid-view-container` (전광판 매트릭스)
2. `'network'`: `network-view-container` (대장주 주가 차트)
3. `'stock'`: `stock-view-container` (종목 중심 압축 관찰판)
4. `'sangtta'`: `sangtta-view-container` (통합 상따 후보 리스트)

## 3. Table Column Alignment & Sorting Conventions
When modifying table UIs (especially `stock-view-container` and `sangtta-view-container`):
- **Exact Column Matching:** Ensure the number of `<td>` cells dynamically generated in `main.js` corresponds 1-to-1 with the `<th>` header tags in `index.html`. For example, in the **종목 압축 관찰판**, Price (현재가), Rate (당일 등락률), and Volume (거래대금) must be independent columns.
- **Header Sorting State:** Each view manages its own sorting state independently:
  - Consolidated view: `currentConsolidatedSortField`, `currentConsolidatedSortAsc`, handled via `sortConsolidatedStocks(field)`.
  - Sangtta view: `currentSangttaSortField`, `currentSangttaSortAsc`, handled via `sortSangttaStocks(field)`.
- **Drawdown (고점대비 낙폭):** When sorted by drop, ascending order is the default since deeper drawdowns (larger negative percentages) represent primary entry targets (타점진입).

## 4. Eye-Fixed Monitoring Mode ("눈고정 모드 ON")
In live financial dashboards, re-sorting table rows every second during background polling causes visual jumps, destroying user UX.
- In `sangtta-view-container`, when `isSangttaOrderLocked === true`, automated data fetches update text and flash colors in-place by DOM querying (`tr[data-symbol]`) without moving row orders or removing items instantly.
- Manual re-sorting is triggered when the user explicitly clicks column headers or the refresh rank button (`fetchAndRenderSangttaStocks(true)`).
