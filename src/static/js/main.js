let countdownValue = 3;
let countdownTimer = null;
let themesData = [];
let recentNews = [];
let leaderSectors3 = [];
let indicesData = {}; // Global store for index data
let expandedStateMap = {}; // Cache cards expanded state by theme name
let isAllExpanded = true; // Track global expansion state

// Track previous values for visual highlighting
let prevPricesMap = {};
let prevIndicesMap = {};
let prevThemeRatesMap = {};

// Fetch all themes and summary details from backend API
async function fetchThemes() {
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
            
            renderSummaryDashboard();
            renderRankingSidebar();
            renderDashboard();
            renderIndices();
        }
    } catch (error) {
        console.error("데이터 로드 중 에러 발생:", error);
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
    const leaderContainer = document.getElementById('leader-sectors-chips');
    if (leaderContainer) {
        leaderContainer.innerHTML = '';
        if (leaderSectors3.length === 0) {
            leaderContainer.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted); padding:0.35rem 0.5rem;">주도 테마 정보가 없습니다.</span>`;
        }
        
        leaderSectors3.forEach((theme, index) => {
            const rateVal = parseFloat(theme.avg_rate);
            const rateColorClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');
            const rateSign = rateVal > 0 ? '+' : '';

            const chip = document.createElement('div');
            chip.className = 'summary-chip';
            chip.onclick = () => { triggerSearch(theme.theme_name); };
            chip.innerHTML = `
                <span class="chip-rank">${index + 1}</span>
                <span class="chip-name" title="${theme.theme_name}">${theme.theme_name}</span>
                <span class="chip-val ${rateColorClass}">${rateSign}${theme.avg_rate}%</span>
            `;
            leaderContainer.appendChild(chip);
        });
    }

    // 2. Render recent news
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

    // 2. Sort processed themes
    if (sortCriteria === 'rate') {
        processed.sort((a, b) => b.avg_rate - a.avg_rate);
        document.getElementById('ranking-sort-label').innerText = '평균 등락률 순';
    } else {
        processed.sort((a, b) => b.total_volume - a.total_volume);
        document.getElementById('ranking-sort-label').innerText = '거래대금 순';
    }

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
    renderDashboard();
    renderRankingSidebar();
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
                                <span class="stock-name">${stock.stock_name}</span>
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
    startCountdown();
    updateClock();
    setInterval(updateClock, 1000);
};
