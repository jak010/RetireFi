let countdownValue = 3;
let countdownTimer = null;
let themesData = [];
let recentNews = [];
let leaderSectors3 = [];
let indicesData = {}; // Global store for index data
let expandedStateMap = {}; // Cache cards expanded state by theme name
let isAllExpanded = true; // Track global expansion state
let currentSidebarTab = 'theme'; // Sidebar active tab
let kiwoomData = []; // Kiwoom 0181 list

// Track previous values for visual highlighting
let prevPricesMap = {};
let prevIndicesMap = {};
let prevThemeRatesMap = {};

// Fetch all themes and summary details from backend API
let progressInterval = null;
let currentProgress = 0;

function startProgressBar() {
    currentProgress = 0;
    updateProgressBar(0);
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
    
    // Vercel 서버리스의 Stateless 환경 대응을 위한 비선형(Logarithmic) 클라이언트 게이지 시뮬레이션 적용
    progressInterval = setInterval(() => {
        if (currentProgress < 95) {
            currentProgress += (95 - currentProgress) * 0.08;
            updateProgressBar(currentProgress);
        }
    }, 250);
}

function finishProgressBar() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
    updateProgressBar(100);
}

function updateProgressBar(value) {
    const bar = document.getElementById('loading-progress-bar');
    const text = document.getElementById('loading-progress-text');
    if (bar) bar.style.width = `${value}%`;
    if (text) text.innerText = `실시간 시세 연산 중... (${Math.round(value)}%)`;
}

let isFetching = false;

async function fetchThemes() {
    if (isFetching) return;
    isFetching = true;

    const container = document.getElementById('dashboard-grid-container');
    const isFirstLoad = container && container.querySelector('.no-data-msg');

    try {
        const response = await fetch('/api/v1/market/naver-themes');
        const result = await response.json();

        if (result.status === 'success') {
            const rawData = result.data;
            const rawIndices = result.indices || {};

            themesData = rawData;
            recentNews = result.recent_news || [];
            leaderSectors3 = result.leader_sectors_3 || [];
            indicesData = rawIndices;
            
            if (isFirstLoad) {
                finishProgressBar();
                await new Promise(resolve => setTimeout(resolve, 200));
                // 첫 로딩이 완료되면 비로소 주기적인 카운트다운을 가동합니다.
                startCountdown();
            }

            renderSummaryDashboard();
            renderRankingSidebar();
            renderDashboard();
            renderIndices();

            if (currentSidebarTab === 'leader') {
                renderLeaderSectorsList();
            }

            fetchKiwoom0181();
        } else if (result.status === 'loading') {
            // 백엔드의 실제 연산 진행 상태 표시
            const progress = result.progress || 0;
            const step = result.step || '';
            let stepText = '실시간 시세 연산 중...';
            
            if (step === 'mapping') {
                stepText = '네이버 금융 테마 매핑 데이터 수집 중...';
            } else if (step === 'stats') {
                stepText = '종목별 실시간 시세 및 3개월 통계 분석 중...';
            }
            
            updateProgressBar(progress);
            const text = document.getElementById('loading-progress-text');
            if (text) text.innerText = `${stepText} (${progress}%)`;

            // 아직 데이터 로딩이 완료되지 않았으므로 1초 후 폴링
            setTimeout(fetchThemes, 1000);
        }
    } catch (error) {
        console.error("데이터 로드 중 에러 발생:", error);
        if (isFirstLoad) {
            const text = document.getElementById('loading-progress-text');
            if (text) text.innerText = `시세 연산 실패. 잠시 후 재시도합니다.`;
            // 실패 시 3초 후 재시도
            setTimeout(fetchThemes, 3000);
        }
    } finally {
        isFetching = false;
    }
}

// Render Live Market Indices
function renderIndices() {
    const mappings = {
        "kospi": "index-kospi",
        "nasdaq_futures": "index-nasdaq",
        "philadelphia_semiconductor": "index-sox"
    };

    for (const [key, elementId] of Object.entries(mappings)) {
        const data = indicesData[key];
        const el = document.getElementById(elementId);
        if (data && el) {
            const valEl = el.querySelector('.index-val');
            const rateEl = el.querySelector('.index-rate');
            
            if (valEl && rateEl) {
                // Highlighting logic on value change
                const oldPrice = prevIndicesMap[key];
                if (oldPrice !== undefined && oldPrice !== data.price && data.price > 0) {
                    const flashClass = data.price > oldPrice ? 'flash-up-active' : 'flash-down-active';
                    el.classList.remove('flash-up-active', 'flash-down-active');
                    void el.offsetWidth; // Trigger reflow for animation restart
                    el.classList.add(flashClass);
                }
                prevIndicesMap[key] = data.price;

                valEl.innerText = data.price_str;
                
                const rateVal = parseFloat(data.rate_str.replace('%', ''));
                let rateClass = 'flat';
                let rateSign = '';
                if (rateVal > 0) {
                    rateClass = 'up';
                    rateSign = '+';
                } else if (rateVal < 0) {
                    rateClass = 'down';
                }
                
                rateEl.className = `index-rate ${rateClass}`;
                rateEl.innerText = `${rateSign}${data.rate_str}`;
            }
        }
    }
}

// Render Top Panels (Leader TOP 3 & Volume TOP 5)
function renderSummaryDashboard() {
    // 1. Render recent news (주도 업종 TOP3는 좌측 사이드바 탭으로 이동)
    const newsContainer = document.getElementById('recent-news-chips');
    if (newsContainer) {
        newsContainer.innerHTML = '';
        if (recentNews.length === 0) {
            newsContainer.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted); padding:0.35rem 0.5rem;">최근 속보 뉴스가 없습니다.</span>`;
        }
        recentNews.forEach((news) => {
            const chip = document.createElement('div');
            chip.className = 'summary-chip';
            chip.onclick = () => { window.open(news.url, '_blank'); };
            chip.innerHTML = `
                <span class="chip-source">${news.source}</span>
                <span class="chip-name" title="${news.title}">${news.title}</span>
                <span class="chip-time">${news.time_str}</span>
            `;
            newsContainer.appendChild(chip);
        });
        updateTickerPreview();
    }
}

// Apply filters & sorting options to get processed themes
function getProcessedThemes() {
    const searchVal = document.getElementById('search-box').value.trim().toLowerCase();
    const rateFilter = document.getElementById('filter-rate').value;
    const volFilter = document.getElementById('filter-volume').value;
    const targetFilter = document.getElementById('filter-target').value;
    const sortCriteria = document.getElementById('filter-sort').value;

    // 1. Search & select filtering
    let processed = themesData.filter(theme => {
        // Search: Match theme name OR any stock name inside the theme
        const matchesSearch = theme.theme_name.toLowerCase().includes(searchVal) || 
            (theme.top_stocks && theme.top_stocks.some(stock => stock.stock_name.toLowerCase().includes(searchVal)));
        
        if (!matchesSearch) return false;

        // Rate filter
        if (rateFilter === 'up' && theme.avg_rate <= 0) return false;
        if (rateFilter === 'strong' && theme.avg_rate < 5) return false;
        if (rateFilter === 'down' && theme.avg_rate >= 0) return false;

        // Volume filter
        if (volFilter === '500b' && theme.total_volume < 500000000000) return false;
        if (volFilter === '100b' && theme.total_volume < 100000000000) return false;
        if (volFilter === '50b' && theme.total_volume < 50000000000) return false;

        // Target filter
        if (targetFilter === 'has-target') {
            const hasBuyingTarget = theme.top_stocks && theme.top_stocks.some(stock => {
                const isLeaderOr1st = stock.role.includes("대장주") || stock.role === "🥇 1등주";
                const drop = parseFloat(stock.drop);
                return isLeaderOr1st && drop >= -8.0 && drop <= -3.0;
            });
            if (!hasBuyingTarget) return false;
        }

        return true;
    });

    const sortOrder = document.getElementById('filter-sort-order').value;
    const isAsc = (sortOrder === 'asc');
    const orderMultiplier = isAsc ? -1 : 1;

    // 2. Sort processed themes
    let label = '';
    if (sortCriteria === 'rate') {
        processed.sort((a, b) => (b.avg_rate - a.avg_rate) * orderMultiplier);
        label = '평균 등락률 ';
    } else if (sortCriteria === 'composite') {
        processed.sort((a, b) => (a.composite_rank - b.composite_rank) * orderMultiplier);
        label = '종합 순위 ';
    } else if (sortCriteria === 'mapped_count') {
        processed.sort((a, b) => (b.mapped_count - a.mapped_count) * orderMultiplier);
        label = '매핑 종목수 ';
    } else {
        processed.sort((a, b) => (b.total_volume - a.total_volume) * orderMultiplier);
        label = '거래대금 ';
    }
    
    document.getElementById('ranking-sort-label').innerText = label + (isAsc ? '오름차순' : '내림차순');

    return processed;
}

// Render Full Themes Ranking Sidebar on the Left
function renderRankingSidebar() {
    const container = document.getElementById('ranking-list-container');
    const searchBox = document.getElementById('search-box');
    const searchVal = searchBox.value.trim().toLowerCase();

    container.innerHTML = '';
    
    // Apply current filters to sidebar list as well to maintain consistency
    const listData = getProcessedThemes();
    
    if (listData.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.8rem;">매칭 테마가 없습니다.</div>`;
        return;
    }

    listData.forEach((theme, index) => {
        const isSelected = searchVal !== '' && theme.theme_name.toLowerCase() === searchVal;
        const item = document.createElement('div');
        
        const rateVal = parseFloat(theme.avg_rate);
        const rateColorClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');
        const rateSign = rateVal > 0 ? '+' : '';
        
        const oldRate = prevThemeRatesMap[theme.theme_name];
        let flashClass = '';
        if (oldRate !== undefined && oldRate !== theme.avg_rate) {
            flashClass = parseFloat(theme.avg_rate) > parseFloat(oldRate) ? 'flash-up-active' : 'flash-down-active';
        }
        prevThemeRatesMap[theme.theme_name] = theme.avg_rate;

        item.className = `ranking-item ${isSelected ? 'active' : ''} ${flashClass}`;
        
        item.innerHTML = `
            <span class="ranking-num">${index + 1}</span>
            <div style="display: flex; flex-direction: column; min-width: 0; gap: 0.05rem;">
                <span class="ranking-name" title="${theme.theme_name}">${theme.theme_name}</span>
                <span style="font-size: 0.65rem; color: var(--text-secondary); font-weight: 500;">${theme.total_volume_str.split(" ")[0]}</span>
            </div>
            <span class="ranking-rate ${rateColorClass}">${rateSign}${theme.avg_rate}%</span>
            <span class="ranking-share">${theme.volume_share}%</span>
        `;
        
        item.onclick = () => {
            triggerSearch(theme.theme_name);
        };
        
        container.appendChild(item);
    });
    updateSidebarHeaderHighlight();
}

// Trigger filter search when clicking top banner chips or sidebar items
function triggerSearch(themeName) {
    const searchBox = document.getElementById('search-box');
    searchBox.value = themeName;
    
    // Trigger render logic
    onFilterChange();
}

// Triggered when any dropdown filter changes
function onFilterChange() {
    if (activeMainView === 'stock') {
        renderConsolidatedStocks();
    } else {
        renderDashboard();
    }
    renderRankingSidebar();
    updateSidebarHeaderHighlight();
}

function setSidebarSort(criteria) {
    const selectSort = document.getElementById('filter-sort');
    const selectOrder = document.getElementById('filter-sort-order');
    if (selectSort && selectOrder) {
        if (selectSort.value === criteria) {
            selectOrder.value = selectOrder.value === 'desc' ? 'asc' : 'desc';
        } else {
            selectSort.value = criteria;
            selectOrder.value = 'desc';
        }
        onFilterChange();
    }
}

function updateSidebarHeaderHighlight() {
    const sortCriteria = document.getElementById('filter-sort').value;
    const headerSpans = document.querySelectorAll('#theme-table-header span');
    if (headerSpans.length === 4) {
        headerSpans.forEach(span => {
            span.style.color = 'var(--text-muted)';
            span.style.fontWeight = '700';
        });
        if (sortCriteria === 'composite') {
            headerSpans[0].style.color = 'var(--accent-blue)';
        } else if (sortCriteria === 'mapped_count') {
            headerSpans[1].style.color = 'var(--accent-blue)';
        } else if (sortCriteria === 'rate') {
            headerSpans[2].style.color = 'var(--accent-blue)';
        } else if (sortCriteria === 'volume') {
            headerSpans[3].style.color = 'var(--accent-blue)';
        }
    }
}

// Global Collapse/Expand Toggle
function toggleAllCards() {
    isAllExpanded = !isAllExpanded;
    
    // Apply state to all current themes
    themesData.forEach(theme => {
        expandedStateMap[theme.theme_name] = isAllExpanded;
    });
    
    renderDashboard();
}

// Render Main Themes Grid Cards (Top 9 by default or filtered results)
function renderDashboard() {
    const container = document.getElementById('dashboard-grid-container');
    const searchBox = document.getElementById('search-box');
    const searchVal = searchBox.value.trim().toLowerCase();
    const rateFilter = document.getElementById('filter-rate').value;
    const volFilter = document.getElementById('filter-volume').value;
    const targetFilter = document.getElementById('filter-target').value;
    
    const processedThemes = getProcessedThemes();

    if (processedThemes.length === 0) {
        container.innerHTML = `
            <div class="no-data-msg">
                <div class="no-data-icon">🔍</div>
                <h3>필터 결과와 일치하는 테마가 없습니다</h3>
                <p>검색어나 필터 조건을 조정해 주십시오.</p>
            </div>
        `;
        updateSummary(0, 0);
        return;
    }

    container.innerHTML = '';
    
    let displayThemes = [];
    let headerMsg = '';
    
    const hasActiveFilters = searchVal !== '' || rateFilter !== 'all' || volFilter !== 'all' || targetFilter !== 'all';

    // Toggle search clear button based on active filter state
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = hasActiveFilters ? 'flex' : 'none';
    }

    if (!hasActiveFilters) {
        // If there are no active filters, only render top 9 volume themes
        displayThemes = processedThemes.slice(0, 9);
        headerMsg = `⚡ 실시간 거래대금 상위 TOP 9 테마군 (자동 펼침 모니터링)`;
    } else {
        // If filtering, render all matched results
        displayThemes = processedThemes;
        headerMsg = `🔍 필터 매칭 테마군 (${processedThemes.length}개 발견)`;
    }

    // Create Grid Header row
    const gridHeader = document.createElement('div');
    gridHeader.className = 'grid-header-title';
    gridHeader.innerHTML = `
        <span>${headerMsg}</span>
    `;
    container.appendChild(gridHeader);

    let totalBuyingTargets = 0;

    displayThemes.forEach(theme => {
        // Card header styling based on avg_rate
        const rateVal = parseFloat(theme.avg_rate);
        let rateClass = 'flat';
        let rateSign = '';
        if (rateVal > 0) {
            rateClass = 'up';
            rateSign = '+';
        } else if (rateVal < 0) {
            rateClass = 'down';
        }

        // Check for buy targets in this theme
        let hasAlert1 = false;
        let hasAlert2 = false;
        let stocksHtml = '';

        if (theme.top_stocks && theme.top_stocks.length > 0) {
            theme.top_stocks.forEach(stock => {
                const isLeader = stock.role.includes("대장주");
                const is1st = stock.role === "🥇 1등주";
                
                let roleIcon = '▪️';
                if (isLeader) roleIcon = '👑';
                else if (is1st) roleIcon = '🥇';
                else if (stock.role === "🥈 2등주") roleIcon = '🥈';

                // Stock highlights
                let rowClass = '';
                if (isLeader) rowClass = 'leader';
                else if (is1st) rowClass = 'first';

                // Highlighting check on price change
                const oldPrice = prevPricesMap[stock.stock_code];
                let flashClass = '';
                if (oldPrice !== undefined && oldPrice !== stock.price && stock.price > 0) {
                    flashClass = stock.price > oldPrice ? 'flash-up-active' : 'flash-down-active';
                }
                prevPricesMap[stock.stock_code] = stock.price;

                // Drop checks for buy target colors
                const drop = parseFloat(stock.drop);
                let buyZoneClass = '';
                
                if (isLeader || is1st) {
                    if (drop >= -4.0 && drop <= -3.0) {
                        buyZoneClass = 'zone-1';
                        hasAlert1 = true;
                        totalBuyingTargets++;
                    } else if (drop >= -8.0 && drop < -4.0) {
                        buyZoneClass = 'zone-2';
                        hasAlert2 = true;
                        totalBuyingTargets++;
                    }
                }

                let dropColorClass = 'neutral';
                if (drop < -4.0) dropColorClass = 'warning';
                else if (drop < -2.0) dropColorClass = 'success';

                const rateStockVal = parseFloat(stock.rate);
                let stockRateClass = 'flat';
                let stockRateSign = '';
                if (rateStockVal > 0) {
                    stockRateClass = 'up';
                    stockRateSign = '+';
                } else if (rateStockVal < 0) {
                    stockRateClass = 'down';
                }

                stocksHtml += `
                    <div class="stock-row-item ${rowClass} ${buyZoneClass} ${flashClass}" title="${stock.description || ''}">
                        <div class="stock-role-indicator">${roleIcon}</div>
                        <div class="stock-info-block">
                            <div class="stock-name-line">
                                <span class="stock-name" style="cursor: pointer;" onclick="showStockNetworkMap('${stock.stock_name}')" title="클릭 시 연관 테마 네트워크(마인드맵) 탐색">${stock.stock_name}</span>
                                <a href="https://www.tossinvest.com/stocks/A${stock.stock_code}/order" target="_blank" class="stock-code">${stock.stock_code}</a>
                            </div>
                            <div style="font-size: 0.7rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.25rem; margin-top: 0.15rem;">
                                <span style="color: var(--text-muted);">대금:</span>
                                <span style="font-weight: 500;">${stock.volume_str || '-'}</span>
                            </div>
                        </div>
                        <div class="stock-price-block">
                            <div class="stock-price">${stock.price_str}</div>
                            <div class="stock-rate ${stockRateClass}">${stockRateSign}${stock.rate_str}</div>
                        </div>
                        <div class="stock-drop-block">
                            <span class="stock-drop ${dropColorClass}">${stock.drop_str}</span>
                        </div>
                        
                        <!-- Tooltip displaying buy target bands on hover -->
                        <div class="buy-band-tooltip">
                            <div class="tooltip-row">3M 최고가: <span>${stock.three_month_high_str || '-'}</span></div>
                            <div class="tooltip-row">이평선 상태: 
                                <span class="ma-status-badge ${stock.ma10_above_ma20 ? 'golden' : 'dead'}" style="margin-left: 0.25rem;">
                                    ${stock.ma10_above_ma20 ? '10MA > 20MA 🟢' : '10MA ≦ 20MA 🔴'}
                                </span>
                            </div>
                            <div style="border-top: 1px dashed rgba(255,255,255,0.15); margin: 0.35rem 0;"></div>
                            <div class="tooltip-row">1차 매수(-4%~-3%): <span>${stock.buy_zone_1}</span></div>
                            <div class="tooltip-row">2차 매수(-8%~-4%): <span>${stock.buy_zone_2}</span></div>
                        </div>
                    </div>
                `;
            });
        } else {
            stocksHtml = `<div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-size:0.8rem;">활성 종목이 존재하지 않습니다.</div>`;
        }

        // Determine folding state
        // If there's an active buy signal, always expand.
        // If it is the default screen (no active filters) and it's within the top 9, default to expanded (true).
        // Otherwise check cache. Default to collapsed (false).
        if (hasAlert1 || hasAlert2) {
            expandedStateMap[theme.theme_name] = true;
        } else if (!hasActiveFilters && expandedStateMap[theme.theme_name] === undefined) {
            expandedStateMap[theme.theme_name] = true; // 기본 Top 9는 펼친 상태로 초기 로드
        } else if (expandedStateMap[theme.theme_name] === undefined) {
            expandedStateMap[theme.theme_name] = false;
        }

        const isExpanded = expandedStateMap[theme.theme_name];

        // Create Card element
        const card = document.createElement('div');
        card.className = `theme-card ${isExpanded ? 'expanded' : ''} ${hasAlert1 ? 'has-alert-1' : ''} ${hasAlert2 ? 'has-alert-2' : ''}`;

        card.innerHTML = `
            <div class="theme-card-header" onclick="toggleCard('${theme.theme_name}')">
                <div class="theme-title-block">
                    <span class="theme-card-title">${theme.theme_name}</span>
                    <span class="theme-card-subtitle">매핑 종목 수: ${theme.mapped_count} / ${theme.total_count}</span>
                </div>
                <div class="theme-card-metrics">
                    <span class="theme-card-rate ${rateClass}">${rateSign}${theme.avg_rate}%</span>
                    <span class="theme-card-volume">
                        ${theme.total_volume_str.split(" ")[0]}
                        <span class="theme-share-badge">${theme.volume_share}%</span>
                    </span>
                </div>
            </div>
            <div class="theme-card-body">
                ${stocksHtml}
            </div>
        `;

        container.appendChild(card);
    });

    // Sync toggle all button state
    const toggleAllBtn = document.getElementById('btn-toggle-all');
    if (toggleAllBtn) {
        toggleAllBtn.innerHTML = isAllExpanded ? '📁 모두 접기' : '📂 모두 펼치기';
    }

    updateSummary(processedThemes.length, totalBuyingTargets);
}

// Reset all search inputs and select filters
function resetAllFilters() {
    document.getElementById('search-box').value = '';
    document.getElementById('filter-rate').value = 'all';
    document.getElementById('filter-volume').value = 'all';
    document.getElementById('filter-target').value = 'all';
    document.getElementById('filter-sort').value = 'volume';
    
    onFilterChange();
}

// Toggle individual card fold/unfold state
function toggleCard(themeName) {
    expandedStateMap[themeName] = !expandedStateMap[themeName];
    renderDashboard();
}

// Update control bar summary
function updateSummary(themesCount, targetsCount) {
    document.getElementById('themes-count').innerText = themesCount;
    document.getElementById('buying-targets-count').innerText = targetsCount;
}

// Update Live Clock (Current Time Display)
function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const displayEl = document.getElementById('current-time-display');
    if (displayEl) {
        displayEl.innerText = `${hours}:${minutes}:${seconds}`;
    }
}

// Live Auto-Refresh system
function startCountdown() {
    clearInterval(countdownTimer);
    countdownValue = 3;
    document.getElementById('countdown').innerText = countdownValue;
    
    countdownTimer = setInterval(() => {
        countdownValue--;
        if (countdownValue <= 0) {
            countdownValue = 3;
            fetchThemes();
        }
        document.getElementById('countdown').innerText = countdownValue;
    }, 1000);
}

// Live Search Filter
document.getElementById('search-box').addEventListener('input', () => {
    renderDashboard();
    renderRankingSidebar();
});

// Initialize App
window.onload = () => {
    fetchThemes();
    updateClock();
    setInterval(updateClock, 1000);
    initNetworkSVGEvents();
};

// Switch between Ticker Tabs (Kiwoom 0181 vs Breaking News)
let currentTickerTab = 'kiwoom';
function switchTickerTab(tabName) {
    currentTickerTab = tabName;
    const tabKiwoom = document.getElementById('ticker-tab-kiwoom');
    const tabNews = document.getElementById('ticker-tab-news');
    const wrapperKiwoom = document.getElementById('kiwoom-0181-chips');
    const wrapperNews = document.getElementById('recent-news-chips');
    
    if (tabName === 'kiwoom') {
        if (tabKiwoom) tabKiwoom.classList.add('active');
        if (tabNews) tabNews.classList.remove('active');
        if (wrapperKiwoom) wrapperKiwoom.style.display = 'flex';
        if (wrapperNews) wrapperNews.style.display = 'none';
    } else {
        if (tabKiwoom) tabKiwoom.classList.remove('active');
        if (tabNews) tabNews.classList.add('active');
        if (wrapperKiwoom) wrapperKiwoom.style.display = 'none';
        if (wrapperNews) wrapperNews.style.display = 'flex';
    }
    updateTickerPreview();
}

// Toggle bottom sheet popup panel
function toggleTickerPopup() {
    const popup = document.getElementById('ticker-popup-panel');
    if (popup) {
        popup.classList.toggle('show');
        // 팝업이 열릴 때 현재 활성 탭 상태에 맞춰 타이틀 및 콘텐츠를 갱신
        if (popup.classList.contains('show')) {
            switchTickerTab(currentTickerTab);
            const titleEl = document.getElementById('popup-title');
            if (titleEl) {
                titleEl.innerText = currentTickerTab === 'kiwoom' ? '🎯 0181 등락률 상위' : '📰 실시간 주요 속보';
            }
        }
    }
}

// Close bottom sheet popup panel
function closeTickerPopup() {
    const popup = document.getElementById('ticker-popup-panel');
    if (popup) {
        popup.classList.remove('show');
    }
}

// Handles click on ticker tab buttons (with toggle popup logic)
function onTickerTabClick(tabName) {
    const popup = document.getElementById('ticker-popup-panel');
    const isShowing = popup ? popup.classList.contains('show') : false;

    if (isShowing && currentTickerTab === tabName) {
        // Close if clicking the already active tab button while drawer is open
        closeTickerPopup();
    } else {
        // Switch tab content and slide up
        switchTickerTab(tabName);
        if (popup) popup.classList.add('show');
        
        // Update popup title
        const titleEl = document.getElementById('popup-title');
        if (titleEl) {
            titleEl.innerText = tabName === 'kiwoom' ? '🎯 0181 등락률 상위' : '📰 실시간 주요 속보';
        }
    }
}

// Update single line rolling preview text inside ticker bar
function updateTickerPreview() {
    const previewEl = document.getElementById('ticker-preview-text');
    if (!previewEl) return;

    if (currentTickerTab === 'kiwoom' && Array.isArray(kiwoomData) && kiwoomData.length > 0) {
        const topStock = kiwoomData[0];
        const themeText = Array.isArray(topStock.themes) && topStock.themes.length > 0
            ? ` [${topStock.themes[0]}]`
            : '';
        previewEl.innerHTML = `🔥 <span class="preview-highlight">상승률 1위 보통주:</span> ${topStock.name} (${topStock.rate_str})${themeText} &nbsp;&nbsp;|&nbsp;&nbsp; 💡 탭하여 10대 주도 종목 보기`;
    } else if (currentTickerTab === 'news' && Array.isArray(recentNews) && recentNews.length > 0) {
        const topNews = recentNews[0];
        previewEl.innerHTML = `📰 <span class="preview-highlight">최신 속보:</span> ${topNews.title} (${topNews.time_str}) &nbsp;&nbsp;|&nbsp;&nbsp; 💡 탭하여 속보 피드 전체 보기`;
    } else {
        previewEl.innerHTML = `📢 실시간 상승 종목 및 주요 속보를 탭하여 확인하세요.`;
    }
}

// Sidebar Tab Switcher (Theme Ranking vs Leader Sectors)
function switchSidebarTab(tabName) {
    currentSidebarTab = tabName;
    
    const tabTheme = document.getElementById('tab-theme-ranking');
    const tabLeader = document.getElementById('tab-leader-ranking');
    const headerTheme = document.getElementById('theme-ranking-header');
    const headerLeader = document.getElementById('leader-ranking-header');
    const containerTheme = document.getElementById('ranking-list-container');
    const containerLeader = document.getElementById('leader-list-container');
    const tableHeader = document.getElementById('theme-table-header');
    
    if (tabName === 'theme') {
        if (tabTheme) tabTheme.classList.add('active');
        if (tabLeader) tabLeader.classList.remove('active');
        if (headerTheme) headerTheme.style.display = 'flex';
        if (headerLeader) headerLeader.style.display = 'none';
        if (containerTheme) containerTheme.style.display = 'flex';
        if (containerLeader) containerLeader.style.display = 'none';
        if (tableHeader) tableHeader.style.display = 'grid';
    } else {
        if (tabTheme) tabTheme.classList.remove('active');
        if (tabLeader) tabLeader.classList.add('active');
        if (headerTheme) headerTheme.style.display = 'none';
        if (headerLeader) headerLeader.style.display = 'flex';
        if (containerTheme) containerTheme.style.display = 'none';
        if (containerLeader) containerLeader.style.display = 'flex';
        if (tableHeader) tableHeader.style.display = 'none';
        renderLeaderSectorsList(); // 즉시 로드
    }
}

// Fetch Kiwoom 0181 ranking data
async function fetchKiwoom0181() {
    try {
        const response = await fetch('/api/v1/market/kiwoom-0181');
        const result = await response.json();
        if (result.status === 'success') {
            kiwoomData = result.data || [];
            renderKiwoomList();
        }
    } catch (error) {
        console.error("키움 0181 데이터 로드 중 에러 발생:", error);
    }
}

// Render Kiwoom 0181 stock ranking items in top banner
function renderKiwoomList() {
    const container = document.getElementById('kiwoom-0181-chips');
    if (!container) return;
    
    container.innerHTML = '';
    if (!Array.isArray(kiwoomData) || kiwoomData.length === 0) {
        container.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted); padding:0.35rem 0.5rem;">상승 종목 정보가 없습니다.</span>`;
        return;
    }
    
    kiwoomData.slice(0, 10).forEach((stock, index) => {
        const chip = document.createElement('div');
        chip.className = 'summary-chip';
        chip.onclick = () => { triggerSearch(stock.name); };
        
        const rateVal = parseFloat(stock.rate_str.replace('%', '').replace('+', ''));
        const rateClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');

        const themeText = Array.isArray(stock.themes) && stock.themes.length > 0 
            ? `소속 테마: ${stock.themes.join(', ')}` 
            : '소속 테마 없음';

        chip.title = `${stock.name} | ${themeText}`;

        chip.innerHTML = `
            <span class="chip-rank">${index + 1}</span>
            <span class="chip-name" style="max-width: 140px; font-weight: 600; cursor: pointer; text-decoration: underline;" onclick="event.stopPropagation(); showStockNetworkMap('${stock.name}')" title="클릭 시 연관 테마 네트워크(마인드맵) 탐색">${stock.name}</span>
            <span class="chip-val ${rateClass}">${stock.price_str} (${stock.rate_str})</span>
        `;
        
        container.appendChild(chip);
    });
    updateTickerPreview();
}

// Render Leader Sectors Top 3 List in sidebar container
function renderLeaderSectorsList() {
    const container = document.getElementById('leader-list-container');
    if (!container) return;
    
    container.innerHTML = '';
    if (!Array.isArray(leaderSectors3) || leaderSectors3.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.8rem;">주도 테마가 없습니다.</div>`;
        return;
    }
    
    leaderSectors3.forEach((theme, index) => {
        const item = document.createElement('div');
        item.className = 'kiwoom-item';
        
        const rateVal = parseFloat(theme.avg_rate);
        let rateClass = 'rate-flat';
        if (rateVal > 0) rateClass = 'rate-up';
        else if (rateVal < 0) rateClass = 'rate-down';
        
        // 거래대금 표시
        const volStr = theme.total_volume_str || '-';
        
        item.innerHTML = `
            <span class="kiwoom-rank">${index + 1}</span>
            <div class="kiwoom-info">
                <span class="kiwoom-name" title="${theme.theme_name}">${theme.theme_name}</span>
                <span class="kiwoom-code">대장: ${theme.leader_stock || '-'}</span>
            </div>
            <span class="kiwoom-price">${volStr}</span>
            <span class="kiwoom-rate ${rateClass}">${rateVal > 0 ? '+' : ''}${theme.avg_rate}%</span>
        `;
        
        item.onclick = () => {
            triggerSearch(theme.theme_name);
        };
        
        container.appendChild(item);
    });
}

// ==========================================
// Stock Theme Network Mindmap Explorer
// ==========================================
let activeMainView = 'grid'; // 'grid' or 'network'
let currentNetworkStock = ''; // Track currently active network stock
let panX = 0;
let panY = 0;
let zoomScale = 1;

function switchMainView(viewType) {
    activeMainView = viewType;
    const tabGrid = document.getElementById('tab-grid-view');
    const tabNetwork = document.getElementById('tab-network-view');
    const tabStock = document.getElementById('tab-stock-view');
    const gridContainer = document.getElementById('grid-view-container');
    const networkContainer = document.getElementById('network-view-container');
    const stockContainer = document.getElementById('stock-view-container');

    // Reset styles
    [tabGrid, tabNetwork, tabStock].forEach(tab => {
        if (tab) {
            tab.classList.remove('active');
            tab.style.color = 'var(--text-muted)';
        }
    });
    [gridContainer, networkContainer, stockContainer].forEach(c => {
        if (c) c.style.display = 'none';
    });

    if (viewType === 'grid') {
        if (tabGrid) {
            tabGrid.classList.add('active');
            tabGrid.style.color = 'var(--accent-blue)';
        }
        if (gridContainer) gridContainer.style.display = 'block';
        renderDashboard();
    } else if (viewType === 'network') {
        if (tabNetwork) {
            tabNetwork.classList.add('active');
            tabNetwork.style.color = 'var(--accent-blue)';
        }
        if (networkContainer) networkContainer.style.display = 'flex';
        
        // Auto-load a stock network if none is active
        if (!currentNetworkStock) {
            let defaultStock = 'SK하이닉스';
            if (themesData && themesData.length > 0 && themesData[0].top_stocks && themesData[0].top_stocks.length > 0) {
                defaultStock = themesData[0].top_stocks[0].stock_name;
            }
            fetchAndRenderNetwork(defaultStock);
        }
    } else if (viewType === 'stock') {
        if (tabStock) {
            tabStock.classList.add('active');
            tabStock.style.color = 'var(--accent-blue)';
        }
        if (stockContainer) stockContainer.style.display = 'flex';
        renderConsolidatedStocks();
    }
}

function renderConsolidatedStocks() {
    const tbody = document.getElementById('consolidated-stock-tbody');
    const emptyMsg = document.getElementById('stock-view-empty-msg');
    if (!tbody) return;

    tbody.innerHTML = '';

    // 1. Get filtered themes (respects search, rate, volume, signal filters)
    const filteredThemes = getProcessedThemes();

    // 2. Extract unique stocks
    const stockMap = new Map();
    filteredThemes.forEach(theme => {
        if (theme.top_stocks) {
            theme.top_stocks.forEach(stock => {
                const code = stock.stock_code;
                const isLeader = stock.role.includes("대장주") || stock.role.includes("1등주");
                
                if (!stockMap.has(code)) {
                    stockMap.set(code, {
                        code: code,
                        name: stock.stock_name,
                        price_str: stock.price_str,
                        rate: stock.rate,
                        rate_str: stock.rate_str,
                        volume_str: stock.volume_str,
                        volume: stock.volume,
                        drop: parseFloat(stock.drop),
                        drop_str: stock.drop_str,
                        role: stock.role,
                        buy_zone_1: stock.buy_zone_1,
                        buy_zone_2: stock.buy_zone_2,
                        ma10_above_ma20: stock.ma10_above_ma20,
                        description: stock.description,
                        three_month_high_str: stock.three_month_high_str,
                        themes: [theme.theme_name],
                        leaderOfThemes: isLeader ? [theme.theme_name] : []
                    });
                } else {
                    const existing = stockMap.get(code);
                    if (!existing.themes.includes(theme.theme_name)) {
                        existing.themes.push(theme.theme_name);
                    }
                    if (isLeader) {
                        if (!existing.leaderOfThemes.includes(theme.theme_name)) {
                            existing.leaderOfThemes.push(theme.theme_name);
                        }
                        const existingIsLeader = existing.role.includes("대장주") || existing.role.includes("1등주");
                        if (!existingIsLeader) {
                            existing.role = stock.role;
                        }
                    }
                }
            });
        }
    });

    const consolidatedList = Array.from(stockMap.values());

    if (consolidatedList.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    } else {
        if (emptyMsg) emptyMsg.style.display = 'none';
    }

    // 3. Sort unique stocks based on active filter-sort and filter-sort-order
    const sortCriteria = document.getElementById('filter-sort').value;
    const sortOrder = document.getElementById('filter-sort-order').value;
    const isAsc = (sortOrder === 'asc');
    const orderMultiplier = isAsc ? -1 : 1;

    consolidatedList.sort((a, b) => {
        if (sortCriteria === 'rate') {
            return (parseFloat(b.rate) - parseFloat(a.rate)) * orderMultiplier;
        } else if (sortCriteria === 'composite') {
            // Sort by number of mapped themes (multi-themed stocks first)
            return (b.themes.length - a.themes.length) * orderMultiplier;
        } else if (sortCriteria === 'mapped_count') {
            // Sort by drop (drawdown)
            return (parseFloat(a.drop) - parseFloat(b.drop)) * orderMultiplier;
        } else {
            // Sort by volume amount
            return (b.volume - a.volume) * orderMultiplier;
        }
    });

    // 4. Render Table Rows
    consolidatedList.forEach(stock => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-color)';
        tr.style.transition = 'background 0.2s';
        
        // Highlight rows on hover
        tr.onmouseover = () => { tr.style.background = 'rgba(0,0,0,0.01)'; };
        tr.onmouseout = () => { tr.style.background = 'transparent'; };

        // Rate styles
        const rateVal = parseFloat(stock.rate);
        const rateClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');
        const rateSign = rateVal > 0 ? '+' : '';

        // Drop styles
        let dropColor = 'var(--text-primary)';
        if (stock.drop < -4.0) dropColor = 'var(--accent-red)';
        else if (stock.drop < -2.0) dropColor = '#d97706';

        // Mapped Themes tags HTML
        const themeTagsHtml = stock.themes.map(themeName => {
            return `<span class="theme-tag" onclick="triggerSearch('${themeName}')" style="display: inline-block; font-size: 0.65rem; background: #f1f5f9; color: var(--text-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; margin-right: 0.3rem; margin-bottom: 0.3rem; cursor: pointer; font-weight: 600; border: 1px solid var(--border-color); transition: all 0.2s;" onmouseover="this.style.background='var(--accent-blue-glow)'; this.style.color='var(--accent-blue)';" onmouseout="this.style.background='#f1f5f9'; this.style.color='var(--text-secondary)';">${themeName}</span>`;
        }).join('');

        // Leader Badge
        const isStockLeader = stock.leaderOfThemes && stock.leaderOfThemes.length > 0;
        const leaderThemesStr = isStockLeader ? stock.leaderOfThemes.join(', ') : '';
        const leaderBadgeHtml = isStockLeader
            ? `<span style="font-size: 0.55rem; background: #fef3c7; color: #d97706; padding: 0.05rem 0.25rem; border-radius: 4px; font-weight: 700; border: 1px solid #fde68a; margin-left: 0.25rem; cursor: help;" title="대장 테마: ${leaderThemesStr}">대장</span>`
            : '';

        // Buy Zone Alert Badge
        let alertBadge = '<span style="color: var(--text-muted); font-size: 0.65rem; font-weight: 500;">신호 없음</span>';
        
        // Check if inside Buy Zone 1 or 2
        if (isStockLeader) {
            if (stock.drop >= -8.0 && stock.drop <= -3.0) {
                alertBadge = '<span style="background: #ecfdf5; color: #10b981; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 700; border: 1px solid #a7f3d0; display: inline-flex; align-items: center; gap: 0.15rem;">🟢 타점진입</span>';
            } else if (stock.drop < -8.0) {
                alertBadge = '<span style="background: #fffbeb; color: #d97706; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 700; border: 1px solid #fde68a; display: inline-flex; align-items: center; gap: 0.15rem;">🟡 과락구간</span>';
            } else {
                alertBadge = '<span style="background: #fef2f2; color: #ef4444; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 700; border: 1px solid #fca5a5; display: inline-flex; align-items: center; gap: 0.15rem;">🔴 관망구간</span>';
            }
        }

        tr.innerHTML = `
            <td style="padding: 0.6rem 0.5rem; font-weight: 600; color: var(--text-primary);">
                <div style="display: flex; align-items: center; gap: 0.2rem;">
                    <span style="cursor: pointer; text-decoration: underline; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" onclick="showStockNetworkMap('${stock.name}')" title="클릭 시 연관 테마 네트워크(마인드맵) 탐색">${stock.name}</span>
                    ${leaderBadgeHtml}
                </div>
                <div style="font-size: 0.65rem; color: var(--text-muted); margin-top: 0.1rem;">${stock.code}</div>
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 700; font-family: var(--font-outfit);">
                <div>${stock.price_str}</div>
                <div class="${rateClass}" style="font-size: 0.68rem; margin-top: 0.1rem;">${rateSign}${stock.rate_str}</div>
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 700; color: ${dropColor}; font-family: var(--font-outfit);">
                ${stock.drop_str}
            </td>
            <td style="padding: 0.6rem 0.5rem 0.6rem 1.5rem; text-align: left;">
                <div style="display: flex; flex-wrap: wrap; gap: 0.1rem;">
                    ${themeTagsHtml}
                </div>
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: center; vertical-align: middle;">
                ${alertBadge}
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: center;">
                <div style="display: flex; gap: 0.4rem; justify-content: center; align-items: center;">
                    <button onclick="showStockNetworkMap('${stock.name}')" style="padding: 0.25rem 0.5rem; background: var(--accent-blue-glow); color: var(--accent-blue); border: 1px solid var(--accent-blue); border-radius: 4px; font-size: 0.65rem; font-weight: 600; cursor: pointer;" title="연관 테마 마인드맵 보기">마인드맵</button>
                    <a href="https://www.tossinvest.com/stocks/A${stock.code}/order" target="_blank" style="padding: 0.25rem 0.5rem; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 4px; font-size: 0.65rem; font-weight: 600; text-decoration: none; display: inline-block;" title="토스증권에서 주문">토스</a>
                </div>
            </td>
        `;

        // Tooltip displaying buy target bands on hover of the row
        let rowTooltip = `${stock.name} | ${stock.description || ''}`;
        if (isStockLeader) {
            rowTooltip += `\n★ 대장 테마: ${leaderThemesStr}`;
        }
        rowTooltip += `\n3M 최고가: ${stock.three_month_high_str || '-'}\n1차 타점: ${stock.buy_zone_1 || '-'}\n2차 타점: ${stock.buy_zone_2 || '-'}`;
        tr.title = rowTooltip;

        tbody.appendChild(tr);
    });
}

async function fetchAndRenderNetwork(stockName) {
    if (!stockName) return;
    currentNetworkStock = stockName;
    
    const loader = document.getElementById('network-loader');
    if (loader) loader.style.display = 'flex';
    
    const input = document.getElementById('network-search-input');
    if (input) input.value = stockName;
    
    try {
        const response = await fetch(`/api/v1/market/stocks/${encodeURIComponent(stockName)}/network`);
        const result = await response.json();
        
        // Race condition check: Only render if the current active stock matches the requested stock
        if (currentNetworkStock !== stockName) {
            console.log(`Skipped rendering for ${stockName} due to race condition.`);
            return;
        }
        
        if (result.status === 'success') {
            renderNetworkMindmap(result);
        } else {
            alert(result.message || '네트워크 조회 실패');
        }
    } catch (e) {
        console.error('Error fetching stock network:', e);
    } finally {
        if (loader && currentNetworkStock === stockName) {
            loader.style.display = 'none';
        }
    }
}

function searchNetworkStock() {
    const input = document.getElementById('network-search-input');
    if (input) {
        const val = input.value.trim();
        if (val) {
            fetchAndRenderNetwork(val);
        }
    }
}

function showStockNetworkMap(stockName) {
    currentNetworkStock = stockName; // Set it first to prevent switchMainView from loading the default stock
    switchMainView('network');
    fetchAndRenderNetwork(stockName);
}

function resetNetworkTransform() {
    panX = 0;
    panY = 0;
    zoomScale = 1;
    updateNetworkTransform();
}

function zoomNetwork(factor) {
    zoomScale *= factor;
    zoomScale = Math.max(0.3, Math.min(3, zoomScale));
    updateNetworkTransform();
}

function updateNetworkTransform() {
    const g = document.getElementById('network-g');
    if (g) {
        g.setAttribute('transform', `translate(${panX}, ${panY}) scale(${zoomScale})`);
    }
}

function initNetworkSVGEvents() {
    const svg = document.getElementById('network-svg');
    if (!svg) return;

    let isDragging = false;
    let startX, startY;

    svg.addEventListener('mousedown', (e) => {
        if (e.target.closest('.network-node-html')) return;
        isDragging = true;
        svg.style.cursor = 'grabbing';
        startX = e.clientX - panX;
        startY = e.clientY - panY;
    });

    svg.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateNetworkTransform();
    });

    svg.addEventListener('mouseup', () => {
        isDragging = false;
        svg.style.cursor = 'grab';
    });

    svg.addEventListener('mouseleave', () => {
        isDragging = false;
        svg.style.cursor = 'grab';
    });

    svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = 1.1;
        if (e.deltaY < 0) {
            zoomScale *= factor;
        } else {
            zoomScale /= factor;
        }
        zoomScale = Math.max(0.3, Math.min(3, zoomScale));
        updateNetworkTransform();
    }, { passive: false });
}

function renderNetworkMindmap(data) {
    const svg = document.getElementById('network-svg');
    const linksGroup = document.getElementById('network-links');
    const nodesGroup = document.getElementById('network-nodes');
    if (!svg || !linksGroup || !nodesGroup) return;

    // Clear previous
    linksGroup.innerHTML = '';
    nodesGroup.innerHTML = '';

    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    
    // Center coordinates
    const cx = width / 2;
    const cy = height / 2;

    resetNetworkTransform();

    const themes = data.themes || [];
    const mainStock = data.stock;

    // Create main stock node
    createSVGNode(nodesGroup, cx, cy, 185, 75, `
        <div class="network-node-html main-node" style="width: 100%; height: 100%; background: #ffffff; border: 3px solid var(--accent-blue); border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(29, 78, 216, 0.15); display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 0.5rem; text-align: center; cursor: default; user-select: none;">
            <div style="font-size: 0.85rem; font-weight: 800; color: var(--text-primary); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${mainStock.name}</div>
            <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 600; margin-top: 0.1rem;">${mainStock.code}</div>
            <div style="font-size: 0.75rem; font-weight: 700; color: var(--accent-blue); margin-top: 0.15rem;">${mainStock.price_str} (${mainStock.rate_str})</div>
        </div>
    `);

    const numThemes = themes.length;
    if (numThemes === 0) return;

    // Split themes into Left and Right lists
    const leftThemes = themes.filter((_, idx) => idx % 2 === 0);
    const rightThemes = themes.filter((_, idx) => idx % 2 !== 0);

    // Count stock slots on left
    let leftStockCount = 0;
    leftThemes.forEach(t => {
        const validStocks = (t.stocks || []).filter(s => s.stock_code !== mainStock.code);
        leftStockCount += Math.max(1, validStocks.length);
    });

    // Count stock slots on right
    let rightStockCount = 0;
    rightThemes.forEach(t => {
        const validStocks = (t.stocks || []).filter(s => s.stock_code !== mainStock.code);
        rightStockCount += Math.max(1, validStocks.length);
    });

    const slotHeight = 65; // vertical height per slot

    // 1. Render Left Side
    const leftTotalHeight = leftStockCount * slotHeight;
    let leftY = cy - leftTotalHeight / 2 + slotHeight / 2;

    leftThemes.forEach(theme => {
        const validStocks = (theme.stocks || []).filter(s => s.stock_code !== mainStock.code);
        const numStocks = validStocks.length;

        const tx = cx - 220;
        let ty = 0;
        let startY = leftY;

        if (numStocks === 0) {
            ty = leftY;
            leftY += slotHeight;
        } else {
            const endY = leftY + (numStocks - 1) * slotHeight;
            ty = (startY + endY) / 2;
            leftY += numStocks * slotHeight;
        }

        // Render theme node
        renderThemeNode(nodesGroup, tx, ty, theme);
        // Link from center to theme
        drawBezierCurve(linksGroup, cx, cy, tx, ty, 'var(--accent-blue)', 2, true);

        // Render stocks and link from theme to stocks
        const sx = cx - 420;
        validStocks.forEach((stock, idx) => {
            const sy = startY + idx * slotHeight;
            renderStockNode(nodesGroup, sx, sy, stock);
            drawBezierCurve(linksGroup, tx, ty, sx, sy, '#cbd5e1', 1.5, false);
        });
    });

    // 2. Render Right Side
    const rightTotalHeight = rightStockCount * slotHeight;
    let rightY = cy - rightTotalHeight / 2 + slotHeight / 2;

    rightThemes.forEach(theme => {
        const validStocks = (theme.stocks || []).filter(s => s.stock_code !== mainStock.code);
        const numStocks = validStocks.length;

        const tx = cx + 220;
        let ty = 0;
        let startY = rightY;

        if (numStocks === 0) {
            ty = rightY;
            rightY += slotHeight;
        } else {
            const endY = rightY + (numStocks - 1) * slotHeight;
            ty = (startY + endY) / 2;
            rightY += numStocks * slotHeight;
        }

        // Render theme node
        renderThemeNode(nodesGroup, tx, ty, theme);
        // Link from center to theme
        drawBezierCurve(linksGroup, cx, cy, tx, ty, 'var(--accent-blue)', 2, true);

        // Render stocks and link from theme to stocks
        const sx = cx + 420;
        validStocks.forEach((stock, idx) => {
            const sy = startY + idx * slotHeight;
            renderStockNode(nodesGroup, sx, sy, stock);
            drawBezierCurve(linksGroup, tx, ty, sx, sy, '#cbd5e1', 1.5, false);
        });
    });
}

function renderThemeNode(parent, x, y, theme) {
    const rateVal = parseFloat(theme.avg_rate);
    const rateColor = rateVal > 0 ? 'var(--accent-red)' : (rateVal < 0 ? 'var(--accent-blue)' : 'var(--text-muted)');
    const rateSign = rateVal > 0 ? '+' : '';
    
    createSVGNode(parent, x, y, 150, 50, `
        <div class="network-node-html theme-node" style="width: 100%; height: 100%; background: #f8fafc; border: 2px solid var(--border-color); border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 0.4rem; text-align: center; cursor: default; user-select: none;">
            <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${theme.theme_name}">${theme.theme_name}</div>
            <div style="font-size: 0.7rem; font-weight: 700; color: ${rateColor}; margin-top: 0.1rem;">평균 ${rateSign}${theme.avg_rate}%</div>
        </div>
    `);
}

function renderStockNode(parent, x, y, stock) {
    const stockRateVal = parseFloat(stock.rate_str.replace('%', '').replace('+', ''));
    const stockRateColor = stockRateVal > 0 ? 'var(--accent-red)' : (stockRateVal < 0 ? 'var(--accent-blue)' : 'var(--text-muted)');
    
    const isLeader = stock.role.includes("대장주") || stock.role.includes("1등주");
    const roleBadge = isLeader 
        ? `<span style="font-size: 0.55rem; background: #fef3c7; color: #d97706; padding: 0.05rem 0.25rem; border-radius: 4px; font-weight: 700; border: 1px solid #fde68a;">대장</span>` 
        : '';

    createSVGNode(parent, x, y, 140, 50, `
        <div class="network-node-html stock-node" onclick="fetchAndRenderNetwork('${stock.stock_name}')" style="width: 100%; height: 100%; background: #ffffff; border: 1.5px solid var(--border-color); border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.03); display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 0.35rem; text-align: center; cursor: pointer; transition: all 0.2s ease; user-select: none;" onmouseover="this.style.borderColor='var(--accent-blue)'; this.style.transform='scale(1.05)';" onmouseout="this.style.borderColor='var(--border-color)'; this.style.transform='scale(1)';">
            <div style="display: flex; align-items: center; gap: 0.2rem; max-width: 100%; justify-content: center;">
                <span style="font-size: 0.72rem; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90px;" title="${stock.stock_name}">${stock.stock_name}</span>
                ${roleBadge}
            </div>
            <div style="font-size: 0.68rem; font-weight: 600; color: ${stockRateColor}; margin-top: 0.1rem;">${stock.price_str} (${stock.rate_str})</div>
        </div>
    `);
}

function drawBezierCurve(parent, x1, y1, x2, y2, strokeColor, strokeWidth, dashed) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mx = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', strokeColor);
    path.setAttribute('stroke-width', strokeWidth);
    if (dashed) {
        path.setAttribute('stroke-dasharray', '4,4');
    }
    parent.appendChild(path);
}

function createSVGNode(parent, x, y, width, height, htmlContent) {
    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', x - width / 2);
    fo.setAttribute('y', y - height / 2);
    fo.setAttribute('width', width);
    fo.setAttribute('height', height);
    fo.setAttribute('style', 'overflow: visible;');

    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    container.innerHTML = htmlContent;

    fo.appendChild(container);
    parent.appendChild(fo);
}