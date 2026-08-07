function getFormattedRateStr(rateStr, rateVal) {
    let s = (rateStr != null ? rateStr : `${rateVal}%`).toString().trim();
    if (!s.startsWith('+') && !s.startsWith('-') && rateVal > 0) {
        s = '+' + s;
    } else if (!s.startsWith('-') && rateVal < 0) {
        s = '-' + s.replace(/^\+/, '');
    }
    return s.replace(/^(\++)/, '+').replace(/^(\-+)/, '-');
}

let countdownValue = 7;
let countdownTimer = null;
let themesData = [];
let recentNews = [];
let leaderSectors3 = [];
let indicesData = {}; // Global store for index data
let expandedStateMap = {}; // Cache cards expanded state by theme name
let isAllExpanded = true; // Track global expansion state
let currentSidebarTab = 'theme'; // Sidebar active tab
let tossData = []; // Toss ranking list
let currentTossFilter = 'all'; // Toss filters: 'all', 'strong-theme', 'high-rate', 'high-vol-rate'

// 대장주 낙폭 알람 수신 종목 코드 (라디오버튼 설정, 서버에 저장됨, 기본은 안받기)
let alertEnabledCodes = new Set();

async function loadAlertSettings() {
    try {
        const response = await fetch('/api/v1/market/pullback-alert-settings');
        const result = await response.json();
        if (result.status === 'success') {
            alertEnabledCodes = new Set(result.data.enabled_codes || []);
        }
    } catch (error) {
        console.error("알림 설정 로드 실패:", error);
    }
    renderAlertStocksList();
    if (activeMainView === 'network') renderLeaderCharts();
}

async function saveAlertSettings() {
    try {
        await fetch('/api/v1/market/pullback-alert-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled_codes: Array.from(alertEnabledCodes) })
        });
    } catch (error) {
        console.error("알림 설정 저장 실패:", error);
    }
}

function onPullbackAlertChange(code, enabled) {
    if (enabled) {
        alertEnabledCodes.add(code);
    } else {
        alertEnabledCodes.delete(code);
    }
    saveAlertSettings();
    renderAlertStocksList();
    if (activeMainView === 'network') renderLeaderCharts();
}

// Track previous values for visual highlighting
let prevPricesMap = {};
let prevIndicesMap = {};
let prevThemeRatesMap = {};
let enableHighlighting = localStorage.getItem('enableHighlighting') !== 'false';

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

            if (activeMainView === 'network') renderLeaderCharts();
            else if (activeMainView === 'stock') renderConsolidatedStocks();
            else if (activeMainView === 'sangtta') fetchAndRenderSangttaStocks();

            if (currentSidebarTab === 'leader') {
                renderLeaderSectorsList();
            }

            fetchTossRanking();
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
                if (rateVal > 0) {
                    rateClass = 'up';
                } else if (rateVal < 0) {
                    rateClass = 'down';
                }
                
                rateEl.className = `index-rate ${rateClass}`;
                rateEl.innerText = getFormattedRateStr(data.rate_str, rateVal);
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
    } else if (activeMainView === 'grid') {
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

// Download Briefing File
function downloadBriefing() {
    window.open('/api/v1/market/themes/download-briefing', '_blank');
}


// Render Main Themes Grid Cards (Top 9 by default or filtered results)
function renderDashboard() {
    const container = document.getElementById('dashboard-grid-container');
    const searchBox = document.getElementById('search-box');
    const searchVal = searchBox.value.trim().toLowerCase();
    const rateFilter = document.getElementById('filter-rate').value;
    const volFilter = document.getElementById('filter-volume').value;
    const targetFilter = document.getElementById('filter-target').value;
    // 카드 UI에서는 매핑 종목 수가 2개 이하인 테마 제외 (3개 이상인 테마만 표출)
    const processedThemes = getProcessedThemes().filter(t => (t.mapped_count !== undefined ? t.mapped_count : (t.top_stocks ? t.top_stocks.length : 0)) > 2);

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
        // If there are no active filters, only render top 8 volume themes
        displayThemes = processedThemes.slice(0, 8);
        headerMsg = `⚡ 실시간 거래대금 상위 TOP 8 테마군 (자동 펼침 모니터링)`;
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

    const appendThemeCard = (theme) => {
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
            theme.top_stocks.slice(0, 3).forEach(stock => { // 대장주/1등주/2등주 까지만 표시
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
                let changeIndicatorHtml = '';
                if (oldPrice !== undefined && oldPrice !== stock.price && stock.price > 0) {
                    const priceDiff = stock.price - oldPrice;
                    if (enableHighlighting) {
                        flashClass = priceDiff > 0 ? 'flash-up-active' : 'flash-down-active';
                        const diffColor = priceDiff > 0 ? 'var(--accent-red)' : 'var(--accent-blue)';
                        const diffSign = priceDiff > 0 ? '▲' : '▼';
                        changeIndicatorHtml = `<span class="price-diff-badge" style="font-size: 0.62rem; line-height: 1; color: ${diffColor}; font-weight: 700; background: ${priceDiff > 0 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(29, 78, 216, 0.08)'}; padding: 0.1rem 0.2rem; border-radius: 3px; border: 1px solid ${priceDiff > 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(29, 78, 216, 0.15)'}; display: inline-flex; align-items: center; align-self: center;">${diffSign}${Math.abs(priceDiff).toLocaleString()}</span>`;
                    }
                }
                prevPricesMap[stock.stock_code] = stock.price;

                // Drop checks for buy target colors (aligned with backend: 1st zone is -4% ~ -8%, 2nd zone is -8% ~ -12%)
                const drop = parseFloat(stock.drop);
                let buyZoneClass = '';
                
                if (isLeader || is1st) {
                    if (drop >= -8.0 && drop <= -4.4) {
                        buyZoneClass = 'zone-1';
                        hasAlert1 = true;
                        totalBuyingTargets++;
                    } else if (drop >= -12.0 && drop < -8.0) {
                        buyZoneClass = 'zone-2';
                        hasAlert2 = true;
                        totalBuyingTargets++;
                    }
                }

                let dropColorClass = 'neutral';
                if (drop < -8.0) dropColorClass = 'warning';
                else if (drop < -4.4) dropColorClass = 'success';

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
                                <span class="stock-name" style="cursor: pointer;" onclick="showStockNetworkMap('${stock.stock_name}', '${stock.stock_code}')" onmouseenter="handleStockHover(event, '${stock.stock_code}', '${stock.stock_name}')" onmouseleave="handleStockLeave()">${stock.stock_name}</span>
                                <a href="https://www.tossinvest.com/stocks/A${stock.stock_code}/order" target="_blank" class="stock-code">${stock.stock_code}</a>
                            </div>
                            <div style="font-size: 0.7rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.25rem; margin-top: 0.15rem;">
                                <span style="color: var(--text-muted);">대금:</span>
                                <span style="font-weight: 500;">${stock.volume_str || '-'}</span>
                            </div>
                        </div>
                        <div class="stock-price-block">
                            <div class="stock-price" style="display: flex; align-items: center; justify-content: flex-end; gap: 0.25rem;">
                                ${changeIndicatorHtml}
                                <span>${stock.price_str}</span>
                            </div>
                            <div class="stock-rate ${stockRateClass}">${stockRateSign}${stock.rate_str}</div>
                        </div>
                        <div class="stock-drop-block">
                            <span class="stock-drop ${dropColorClass}">${stock.drop_str}</span>
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

        // Generate source badge if present
        let sourceBadgeHtml = '';
        if (theme.source === 'royal') {
            sourceBadgeHtml = `<span class="theme-source-badge royal" style="font-size: 0.65rem; background: var(--accent-blue-glow); color: var(--accent-blue); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(29, 78, 216, 0.2);">로얄</span>`;
        } else if (theme.source === 'naver') {
            sourceBadgeHtml = `<span class="theme-source-badge naver" style="font-size: 0.65rem; background: rgba(16, 185, 129, 0.08); color: var(--accent-green); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.2);">네이버</span>`;
        } else if (theme.source === 'both') {
            sourceBadgeHtml = `
                <span class="theme-source-badge naver" style="font-size: 0.65rem; background: rgba(16, 185, 129, 0.08); color: var(--accent-green); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.2); margin-right: 0.25rem;">네이버</span>
                <span class="theme-source-badge royal" style="font-size: 0.65rem; background: var(--accent-blue-glow); color: var(--accent-blue); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(29, 78, 216, 0.2);">로얄</span>
            `;
        }

        // Generate alert badge if present
        let alertBadgeHtml = '';
        if (hasAlert1) {
            alertBadgeHtml = `<span class="theme-alert-badge alert-1" style="font-size: 0.65rem; background: rgba(16, 185, 129, 0.12); color: var(--accent-green); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.25); margin-left: 0.25rem; display: inline-flex; align-items: center; gap: 2px;">🟢 1차 낙폭</span>`;
        } else if (hasAlert2) {
            alertBadgeHtml = `<span class="theme-alert-badge alert-2" style="font-size: 0.65rem; background: rgba(217, 119, 6, 0.12); color: var(--accent-orange); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(217, 119, 6, 0.25); margin-left: 0.25rem; display: inline-flex; align-items: center; gap: 2px;">🟠 2차 낙폭</span>`;
        }

        // Create Card element
        const card = document.createElement('div');
        card.className = `theme-card ${isExpanded ? 'expanded' : ''} ${hasAlert1 ? 'has-alert-1' : ''} ${hasAlert2 ? 'has-alert-2' : ''}`;

        card.innerHTML = `
            <div class="theme-card-header" onclick="toggleCard('${theme.theme_name}')">
                <div class="theme-title-block">
                    <div style="display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">
                        <span class="theme-card-title">${theme.theme_name}</span>
                        ${sourceBadgeHtml}
                        ${alertBadgeHtml}
                    </div>
                    <span class="theme-card-subtitle" style="display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.15rem;">
                        <span>매핑 종목 수: ${theme.mapped_count} / ${theme.total_count}</span>
                        <span style="font-size: 0.72rem; color: var(--text-muted);">
                            상승 <span style="color: var(--accent-red); font-weight: 600;">▲${theme.up_count || 0}</span> | 
                            하락 <span style="color: var(--accent-blue); font-weight: 600;">▼${theme.down_count || 0}</span>
                            ${theme.flat_count ? ` | 보합 ${theme.flat_count}` : ''}
                        </span>
                    </span>
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
    };

    if (!hasActiveFilters) {
        // 네이버 데이터 상단 배치 (TOP 8)
        const naverThemes = processedThemes.filter(t => t.source === 'naver' || t.source === 'both').slice(0, 8);
        const royalThemes = processedThemes.filter(t => t.source === 'royal' || t.source === 'both').slice(0, 8);

        const naverSectionHeader = document.createElement('div');
        naverSectionHeader.style.cssText = "grid-column: 1 / -1; font-size: 0.95rem; font-weight: 700; color: var(--accent-green); padding: 0.5rem 0 0.4rem 0; border-bottom: 2px solid rgba(16, 185, 129, 0.35); margin-top: 0.25rem; display: flex; align-items: center; gap: 0.5rem; letter-spacing: -0.02em;";
        naverSectionHeader.innerHTML = `🟢 네이버 실시간 거래대금 상위 테마 (상단 TOP 8)`;
        container.appendChild(naverSectionHeader);

        if (naverThemes.length > 0) {
            naverThemes.forEach(appendThemeCard);
        } else {
            const emptyNaver = document.createElement('div');
            emptyNaver.style.cssText = "grid-column: 1 / -1; text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.85rem; background: var(--bg-card); border-radius: 8px; border: 1px dashed var(--border-color);";
            emptyNaver.innerHTML = "수집된 네이버 테마 데이터가 없습니다.";
            container.appendChild(emptyNaver);
        }

        // 로얄로더 데이터 하단 배치 (TOP 8)
        const royalSectionHeader = document.createElement('div');
        royalSectionHeader.style.cssText = "grid-column: 1 / -1; font-size: 0.95rem; font-weight: 700; color: var(--accent-blue); padding: 0.5rem 0 0.4rem 0; border-bottom: 2px solid rgba(29, 78, 216, 0.35); margin-top: 1.5rem; display: flex; align-items: center; gap: 0.5rem; letter-spacing: -0.02em;";
        royalSectionHeader.innerHTML = `🔵 로얄로더 실시간 거래대금 상위 테마 (하단 TOP 8)`;
        container.appendChild(royalSectionHeader);

        if (royalThemes.length > 0) {
            royalThemes.forEach(appendThemeCard);
        } else {
            const emptyRoyal = document.createElement('div');
            emptyRoyal.style.cssText = "grid-column: 1 / -1; text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.85rem; background: var(--bg-card); border-radius: 8px; border: 1px dashed var(--border-color);";
            emptyRoyal.innerHTML = "현재 수집된 로얄로더 테마 데이터가 없습니다.";
            container.appendChild(emptyRoyal);
        }
    } else {
        displayThemes.forEach(appendThemeCard);
    }

    // Sync toggle all button state
    const toggleAllBtn = document.getElementById('btn-toggle-all');
    if (toggleAllBtn) {
        toggleAllBtn.innerHTML = isAllExpanded ? '📁 모두 접기' : '📂 모두 펼치기';
    }

    updateSummary(processedThemes.length, totalBuyingTargets);
    
    // Evaluate and render closing bet candidates
    if (!hasActiveFilters) {
        renderClosingBetCandidates(processedThemes);
    } else {
        const cbSection = document.getElementById('closing-bet-section');
        if (cbSection) cbSection.style.display = 'none';
    }
}

// Toggle highlighting feature
function toggleHighlightFeature(checked) {
    enableHighlighting = checked;
    localStorage.setItem('enableHighlighting', checked);
    renderDashboard();
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
    countdownValue = 7;
    document.getElementById('countdown').innerText = countdownValue;
    
    countdownTimer = setInterval(() => {
        countdownValue--;
        if (countdownValue <= 0) {
            countdownValue = 7;
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
    // Bind toggle highlight state on load
    const toggleEl = document.getElementById('toggle-highlight');
    if (toggleEl) {
        toggleEl.checked = enableHighlighting;
    }
    fetchThemes();
    updateClock();
    setInterval(updateClock, 1000);
    initNetworkSVGEvents();
    loadAlertSettings();
};

// Switch between Ticker Tabs (Breaking News vs Toss)
let currentTickerTab = 'toss';
function switchTickerTab(tabName) {
    currentTickerTab = tabName;
    const tabNews = document.getElementById('ticker-tab-news');
    const tabToss = document.getElementById('ticker-tab-toss');
    const tabAlerts = document.getElementById('ticker-tab-alerts');
    const wrapperNews = document.getElementById('recent-news-chips');
    const wrapperToss = document.getElementById('toss-ranking-chips');
    const wrapperAlerts = document.getElementById('alert-stocks-chips');
    const filterPills = document.getElementById('toss-filter-pills');
    
    [tabNews, tabToss, tabAlerts].forEach(tab => {
        if (tab) tab.classList.remove('active');
    });
    [wrapperNews, wrapperToss, wrapperAlerts].forEach(wrap => {
        if (wrap) wrap.style.display = 'none';
    });
    if (filterPills) filterPills.style.display = 'none';
    
    if (tabName === 'news') {
        if (tabNews) tabNews.classList.add('active');
        if (wrapperNews) wrapperNews.style.display = 'flex';
    } else if (tabName === 'toss') {
        if (tabToss) tabToss.classList.add('active');
        if (wrapperToss) wrapperToss.style.display = 'flex';
        if (filterPills) filterPills.style.display = 'flex';
        fetchTossRanking();
    } else if (tabName === 'alerts') {
        if (tabAlerts) tabAlerts.classList.add('active');
        if (wrapperAlerts) wrapperAlerts.style.display = 'flex';
        renderAlertStocksList();
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
                if (currentTickerTab === 'news') {
                    titleEl.innerText = '📰 실시간 주요 속보';
                } else if (currentTickerTab === 'toss') {
                    titleEl.innerText = '💙 Toss 실시간 거래대금 상위';
                } else if (currentTickerTab === 'alerts') {
                    titleEl.innerText = '🔔 알림 수신 종목';
                }
            }
        }
    }
}

// Close bottom sheet popup panel
function closeTickerPopup() {
    const popup = document.getElementById('ticker-popup-panel');
    if (popup) {
        popup.classList.remove('show');
        popup.classList.remove('pinned');
    }
}

// Toggle Pin state of the popup panel
function togglePinTickerPopup() {
    const popup = document.getElementById('ticker-popup-panel');
    if (popup) {
        popup.classList.toggle('pinned');
    }
}

// Handles click on ticker tab buttons (with toggle popup logic)
function onTickerTabClick(tabName) {
    const popup = document.getElementById('ticker-popup-panel');
    const isShowing = popup ? popup.classList.contains('show') : false;
    const isPinned = popup ? popup.classList.contains('pinned') : false;

    if (isShowing && currentTickerTab === tabName) {
        // Close if clicking the already active tab button while drawer is open (unless pinned)
        if (!isPinned) {
            closeTickerPopup();
        }
    } else {
        // Switch tab content and slide up
        switchTickerTab(tabName);
        if (popup) popup.classList.add('show');
        
        // Update popup title
        const titleEl = document.getElementById('popup-title');
        if (titleEl) {
            if (tabName === 'news') {
                titleEl.innerText = '📰 실시간 주요 속보';
            } else if (tabName === 'toss') {
                titleEl.innerText = '💙 Toss 실시간 거래대금 상위';
            } else if (tabName === 'alerts') {
                titleEl.innerText = '🔔 알림 수신 종목';
            }
        }
    }
}

// Update single line rolling preview text inside ticker bar
function updateTickerPreview() {
    const previewEl = document.getElementById('ticker-preview-text');
    if (!previewEl) return;

    if (currentTickerTab === 'news' && Array.isArray(recentNews) && recentNews.length > 0) {
        const topNews = recentNews[0];
        previewEl.innerHTML = `📰 <span class="preview-highlight">최신 속보:</span> ${topNews.title} (${topNews.time_str}) &nbsp;&nbsp;|&nbsp;&nbsp; 💡 탭하여 속보 피드 전체 보기`;
    } else if (currentTickerTab === 'toss' && Array.isArray(tossData) && tossData.length > 0) {
        const topStock = tossData[0];
        const themeText = Array.isArray(topStock.themes) && topStock.themes.length > 0
            ? ` [${topStock.themes[0]}]`
            : '';
        previewEl.innerHTML = `💙 <span class="preview-highlight">Toss 대금 1위:</span> ${topStock.name} (${topStock.price_str}, ${topStock.rate_str})${themeText} &nbsp;&nbsp;|&nbsp;&nbsp; 💡 탭하여 실시간 거래 순위 보기`;
    } else if (currentTickerTab === 'alerts') {
        const count = alertEnabledCodes.size;
        previewEl.innerHTML = `🔔 <span class="preview-highlight">알림 수신 종목 ${count}개:</span> &nbsp;&nbsp;|&nbsp;&nbsp; 💡 탭하여 알림 수신 종목 확인`;
    } else {
        previewEl.innerHTML = `📢 실시간 주요 속보 및 Toss 인기 거래 순위를 확인하세요.`;
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

// Fetch Toss trading volume ranking data
async function fetchTossRanking() {
    try {
        const response = await fetch('/api/v1/market/toss-ranking');
        const result = await response.json();
        if (result.status === 'success') {
            tossData = result.data || [];
            renderTossRankingList();
        }
    } catch (error) {
        console.error("Toss 랭킹 데이터 로드 중 에러 발생:", error);
    }
}

// Set active Toss filter and re-render
function setTossFilter(filterName) {
    currentTossFilter = filterName;
    
    // Update active class on filter buttons
    const buttons = document.querySelectorAll('.toss-filter-btn');
    buttons.forEach(btn => {
        if (btn.getAttribute('onclick').includes(filterName)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    renderTossRankingList();
}

// Render Toss ranking stock list in slide-up popup
function renderTossRankingList() {
    const container = document.getElementById('toss-ranking-chips');
    if (!container) return;
    
    container.innerHTML = '';
    if (!Array.isArray(tossData) || tossData.length === 0) {
        container.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted); padding:0.35rem 0.5rem;">Toss 거래 순위 정보가 없습니다.</span>`;
        return;
    }
    
    // Apply filters
    let filtered = tossData;
    if (currentTossFilter === 'strong-theme') {
        // Get top 5 themes by total_volume from themesData
        const topThemeNames = themesData.slice(0, 5).map(t => t.theme_name);
        filtered = tossData.filter(stock => 
            Array.isArray(stock.themes) && stock.themes.some(name => topThemeNames.includes(name))
        );
        // Sort by rate descending (highest rate first)
        filtered.sort((a, b) => b.rate - a.rate);
    } else if (currentTossFilter === 'high-rate') {
        // Sort by rate descending
        let sorted = [...tossData].sort((a, b) => b.rate - a.rate);
        filtered = sorted.filter(stock => stock.rate >= 3.0);
        // Fallback to lower thresholds if too few items match (e.g. on down market days)
        if (filtered.length < 5) {
            filtered = sorted.filter(stock => stock.rate >= 1.0);
        }
        if (filtered.length < 5) {
            filtered = sorted.filter(stock => stock.rate >= 0.0);
        }
        if (filtered.length < 5) {
            filtered = sorted.slice(0, 15);
        }
    } else if (currentTossFilter === 'high-vol-rate') {
        // Sort by volume descending
        let sorted = [...tossData].sort((a, b) => b.volume - a.volume);
        filtered = sorted.filter(stock => stock.volume >= 30000000000 && stock.rate >= 2.0);
        // Fallback to lower thresholds if too few items match
        if (filtered.length < 5) {
            filtered = sorted.filter(stock => stock.volume >= 10000000000 && stock.rate >= 0.5);
        }
        if (filtered.length < 5) {
            filtered = sorted.filter(stock => stock.volume >= 5000000000 && stock.rate >= 0.0);
        }
        if (filtered.length < 5) {
            filtered = sorted.slice(0, 15);
        }
    }
    
    if (filtered.length === 0) {
        container.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted); padding:1rem 0.5rem; text-align:center; width:100%;">조건에 일치하는 종목이 없습니다.</span>`;
        return;
    }
    
    filtered.slice(0, 30).forEach((stock) => {
        const chip = document.createElement('div');
        chip.className = 'summary-chip toss-chip';
        chip.onclick = () => { window.open(stock.toss_url, '_blank'); };
        
        const rateVal = parseFloat(stock.rate);
        const rateClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');
        const cleanRateStr = getFormattedRateStr(stock.rate_str, rateVal);

        const hasTheme = Array.isArray(stock.themes) && stock.themes.length > 0;
        const themeTextHtml = hasTheme
            ? `<div style="font-size: 0.68rem; color: var(--accent-blue); font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 200px;">🏷️ ${stock.themes.join(', ')}</div>`
            : `<div style="font-size: 0.68rem; color: var(--text-muted);">소속 테마 없음</div>`;

        chip.title = `${stock.name} | 대금: ${stock.volume_str} | ${hasTheme ? stock.themes.join(', ') : '소속 테마 없음'}`;

        chip.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.35rem;">
                    <span class="chip-rank" style="background: rgba(0, 102, 255, 0.1); color: #0066ff;">${stock.rank}</span>
                    <span style="font-weight: 700; color: var(--text-primary);">${stock.name}</span>
                </div>
                <span class="chip-val ${rateClass}" style="font-weight: 600;">${stock.price_str} (${cleanRateStr})</span>
            </div>
            <div style="display: flex; justify-content: space-between; width: 100%; font-size: 0.68rem; color: var(--text-secondary); margin-top: 0.1rem;">
                <span>대금: <strong style="color: var(--text-primary);">${stock.volume_str}</strong></span>
                ${hasTheme ? `<span style="color: var(--accent-green); font-weight: 600;">테마 매핑</span>` : ''}
            </div>
            ${themeTextHtml}
        `;
        
        container.appendChild(chip);
    });
    updateTickerPreview();
}



// Render Alert-Enabled Stocks List in the bottom ticker popup (alerts tab)
function renderAlertStocksList() {
    const container = document.getElementById('alert-stocks-chips');
    if (!container) return;
    container.innerHTML = '';

    const codes = Array.from(alertEnabledCodes);
    if (codes.length === 0) {
        container.innerHTML = `<span style="font-size:0.75rem; color:var(--text-muted); padding:0.35rem 0.5rem;">알람이 설정된 종목이 없습니다. 종목 압축 관찰판의 알림 설정에서 받기를 선택하세요.</span>`;
        updateTickerPreview();
        return;
    }

    // 종목 코드 -> 종목 정보 맵 구축 (테마 데이터의 대장주/1등주 등 상위 종목 기준)
    const stockMap = new Map();
    themesData.forEach(theme => {
        (theme.top_stocks || []).forEach(stock => {
            if (!stockMap.has(stock.stock_code)) {
                stockMap.set(stock.stock_code, { ...stock, theme_name: theme.theme_name });
            }
        });
    });

    codes.forEach((code) => {
        const stock = stockMap.get(code);
        if (!stock) return;
        const chip = document.createElement('div');
        chip.className = 'summary-chip';
        chip.style.cursor = 'pointer';
        chip.title = `${stock.stock_name} | ${stock.theme_name || ''} | ${stock.role || ''} (클릭 시 관찰판에서 위치 확인)`;
        chip.onclick = () => { closeTickerPopup(); focusConsolidatedStock(code); };
        const rateVal = parseFloat(stock.rate);
        const rateClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');
        chip.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.35rem; min-width: 0;">
                    <span style="font-weight: 700; color: var(--text-primary); white-space: nowrap;">${stock.stock_name}</span>
                    <span style="font-size: 0.68rem; color: var(--accent-green); font-weight: 600; white-space: nowrap;">${stock.role || ''}</span>
                </div>
                <span class="chip-val ${rateClass}" style="font-weight: 600; white-space: nowrap;">${stock.price_str} (${stock.rate_str})</span>
            </div>
            <div style="display: flex; justify-content: space-between; width: 100%; font-size: 0.68rem; color: var(--text-secondary); margin-top: 0.1rem; gap: 0.5rem;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🏷️ ${stock.theme_name || '소속 테마 없음'}</span>
                <span style="color: var(--accent-red); font-weight: 600; white-space: nowrap;">🔔 알람 수신</span>
            </div>
        `;
        container.appendChild(chip);
    });
    updateTickerPreview();
}

// Point to the stock's row in the consolidated stock view, with a temporary highlight
function focusConsolidatedStock(code) {
    switchMainView('stock');
    let row = document.getElementById('consolidated-row-' + code);
    if (!row) {
        resetAllFilters();
        row = document.getElementById('consolidated-row-' + code);
    }
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.style.background = 'rgba(250, 204, 21, 0.25)';
    setTimeout(() => { row.style.background = 'transparent'; }, 2500);
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



let currentConsolidatedSortField = 'rate'; // 'price', 'rate', 'volume', 'drop'
let currentConsolidatedSortAsc = false;     // 기본 내림차순

function sortConsolidatedStocks(field) {
    if (currentConsolidatedSortField === field) {
        currentConsolidatedSortAsc = !currentConsolidatedSortAsc;
    } else {
        currentConsolidatedSortField = field;
        currentConsolidatedSortAsc = (field === 'drop'); // 고점대비 낙폭은 음수가 깊을수록(오름차순) 기본 정렬
    }
    updateConsolidatedSortIcons();
    renderConsolidatedStocks();
}

function updateConsolidatedSortIcons() {
    ['price', 'rate', 'volume', 'drop'].forEach(f => {
        const arrowEl = document.getElementById(`sort-arrow-c-${f}`);
        const thEl = arrowEl ? arrowEl.parentElement : null;
        if (!arrowEl) return;

        if (currentConsolidatedSortField === f) {
            if (currentConsolidatedSortAsc) {
                arrowEl.innerHTML = `▲`;
                arrowEl.style.color = '#2563eb';
                arrowEl.style.opacity = '1';
                if (thEl) thEl.style.color = '#2563eb';
            } else {
                arrowEl.innerHTML = `▼`;
                arrowEl.style.color = '#dc2626';
                arrowEl.style.opacity = '1';
                if (thEl) thEl.style.color = '#dc2626';
            }
        } else {
            arrowEl.innerHTML = `▲▼`;
            arrowEl.style.color = 'var(--text-muted)';
            arrowEl.style.opacity = '0.35';
            if (thEl) thEl.style.color = 'var(--text-secondary)';
        }
    });
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

                // 압축 관찰판에는 대장주만 표기합니다.
                if (!isLeader) return;
                
                if (!stockMap.has(code)) {
                    stockMap.set(code, {
                        code: code,
                        name: stock.stock_name,
                        price: stock.price !== undefined ? stock.price : parseFloat((stock.price_str || '').replace(/[^0-9.-]/g, '')) || 0,
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

    // 3. Sort unique stocks based on active consolidated table sort settings
    consolidatedList.sort((a, b) => {
        const valA = parseFloat(a[currentConsolidatedSortField]) || 0;
        const valB = parseFloat(b[currentConsolidatedSortField]) || 0;
        return currentConsolidatedSortAsc ? (valA - valB) : (valB - valA);
    });
    updateConsolidatedSortIcons();

    // 4. Render Table Rows
    consolidatedList.forEach(stock => {
        const tr = document.createElement('tr');
        tr.id = 'consolidated-row-' + stock.code;
        tr.style.borderBottom = '1px solid var(--border-color)';
        tr.style.transition = 'background 0.2s';
        
        // Highlight rows on hover
        tr.onmouseover = () => { tr.style.background = 'rgba(0,0,0,0.01)'; };
        tr.onmouseout = () => { tr.style.background = 'transparent'; };

        // Rate styles
        const rateVal = parseFloat(stock.rate);
        const rateClass = rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat');
        const cleanRateStr = getFormattedRateStr(stock.rate_str, rateVal);

        // Drop styles
        let dropColor = 'var(--text-primary)';
        if (stock.drop < -4.4) dropColor = 'var(--accent-red)';
        else if (stock.drop < -2.0) dropColor = '#d97706';

        // Mapped Themes tags HTML
        const themeTagsHtml = stock.themes.map(themeName => {
            return `<span class="theme-tag" onclick="triggerSearch('${themeName}')" style="display: inline-block; font-size: 0.65rem; background: #f1f5f9; color: var(--text-secondary); padding: 0.15rem 0.4rem; border-radius: 4px; margin-right: 0.3rem; margin-bottom: 0.3rem; cursor: pointer; font-weight: 600; border: 1px solid var(--border-color); transition: all 0.2s;" onmouseover="this.style.background='var(--accent-blue-glow)'; this.style.color='var(--accent-blue)';" onmouseout="this.style.background='#f1f5f9'; this.style.color='var(--text-secondary)';" >${themeName}</span>`;
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
                    <span style="cursor: pointer; text-decoration: underline; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" onclick="showStockNetworkMap('${stock.name}', '${stock.code}')">${stock.name}</span>
                    ${leaderBadgeHtml}
                </div>
                <div style="font-size: 0.65rem; color: var(--text-muted); margin-top: 0.1rem;">${stock.code}</div>
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 700; font-family: var(--font-outfit); font-size: 0.85rem;">
                ${stock.price_str}
            </td>
            <td class="${rateClass}" style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 800; font-family: var(--font-outfit); font-size: 0.85rem;">
                ${cleanRateStr}
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 700; color: #4338ca; font-family: var(--font-outfit); font-size: 0.82rem;">
                ${stock.volume_str || '-'}
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 700; color: ${dropColor}; font-family: var(--font-outfit); font-size: 0.85rem;">
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
            <td style="padding: 0.6rem 0.5rem; text-align: center; vertical-align: middle; white-space: nowrap;">
                <label style="font-size: 0.68rem; font-weight: 600; color: var(--accent-green); cursor: pointer; margin-right: 0.45rem;" title="이 종목의 대장주 낙폭 알람을 받습니다">
                    <input type="radio" name="alert-${stock.code}" value="on" ${alertEnabledCodes.has(stock.code) ? 'checked' : ''} onchange="onPullbackAlertChange('${stock.code}', true)" style="cursor: pointer; accent-color: #10b981;"> 받기
                </label>
                <label style="font-size: 0.68rem; font-weight: 600; color: var(--accent-red); cursor: pointer;" title="이 종목의 대장주 낙폭 알람을 받지 않습니다">
                    <input type="radio" name="alert-${stock.code}" value="off" ${alertEnabledCodes.has(stock.code) ? '' : 'checked'} onchange="onPullbackAlertChange('${stock.code}', false)" style="cursor: pointer; accent-color: #ef4444;"> 안받기
                </label>
            </td>
            <td style="padding: 0.6rem 0.5rem; text-align: center;">
                <div style="display: flex; gap: 0.4rem; justify-content: center; align-items: center;">
                    <button onclick="showStockNetworkMap('${stock.name}', '${stock.code}')" style="padding: 0.25rem 0.5rem; background: var(--accent-blue-glow); color: var(--accent-blue); border: 1px solid var(--accent-blue); border-radius: 4px; font-size: 0.65rem; font-weight: 600; cursor: pointer;" title="실시간 주가 차트 보기">차트</button>
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

// ==========================================
// 실시간 대장주 주가 변동 차트 모니터링
// ==========================================
let activeMainView = 'grid'; // 'grid', 'network', 'stock', 'sangtta'
let currentNetworkStock = ''; // Track currently highlighted stock code
let chartInstances = {}; // To store Chart.js instances

function switchMainView(viewType) {
    activeMainView = viewType;
    const tabGrid = document.getElementById('tab-grid-view');
    const tabNetwork = document.getElementById('tab-network-view');
    const tabStock = document.getElementById('tab-stock-view');
    const tabSangtta = document.getElementById('tab-sangtta-view');
    const gridContainer = document.getElementById('grid-view-container');
    const networkContainer = document.getElementById('network-view-container');
    const stockContainer = document.getElementById('stock-view-container');
    const sangttaContainer = document.getElementById('sangtta-view-container');

    // Reset styles
    [tabGrid, tabNetwork, tabStock, tabSangtta].forEach(tab => {
        if (tab) {
            tab.classList.remove('active');
            tab.style.color = 'var(--text-muted)';
        }
    });
    [gridContainer, networkContainer, stockContainer, sangttaContainer].forEach(c => {
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
        if (networkContainer) networkContainer.style.display = 'block';
        renderLeaderCharts();
    } else if (viewType === 'stock') {
        if (tabStock) {
            tabStock.classList.add('active');
            tabStock.style.color = 'var(--accent-blue)';
        }
        if (stockContainer) stockContainer.style.display = 'flex';
        updateConsolidatedSortIcons();
        renderConsolidatedStocks();
    } else if (viewType === 'sangtta') {
        if (tabSangtta) {
            tabSangtta.classList.add('active');
            tabSangtta.style.color = '#dc2626';
        }
        if (sangttaContainer) sangttaContainer.style.display = 'flex';
        updateSangttaSortIcons();
        fetchAndRenderSangttaStocks();
    }
}

let sangttaData = [];
let isSangttaOrderLocked = true;
let currentSangttaSortField = 'rate'; // 'price', 'rate', 'volume'
let currentSangttaSortAsc = false;     // 기본 내림차순

function sortSangttaStocks(field) {
    if (currentSangttaSortField === field) {
        currentSangttaSortAsc = !currentSangttaSortAsc;
    } else {
        currentSangttaSortField = field;
        currentSangttaSortAsc = false; // 신규 컬럼 선택 시 높은순(내림차순)을 기본으로
    }
    updateSangttaSortIcons();
    fetchAndRenderSangttaStocks(true, true); // (forceReorder=true, useLocalData=true)
}

function updateSangttaSortIcons() {
    ['price', 'rate', 'volume'].forEach(f => {
        const arrowEl = document.getElementById(`sort-arrow-${f}`);
        const thEl = arrowEl ? arrowEl.parentElement : null;
        if (!arrowEl) return;

        if (currentSangttaSortField === f) {
            if (currentSangttaSortAsc) {
                arrowEl.innerHTML = `▲`;
                arrowEl.style.color = '#2563eb';
                arrowEl.style.opacity = '1';
                if (thEl) thEl.style.color = '#2563eb';
            } else {
                arrowEl.innerHTML = `▼`;
                arrowEl.style.color = '#dc2626';
                arrowEl.style.opacity = '1';
                if (thEl) thEl.style.color = '#dc2626';
            }
        } else {
            arrowEl.innerHTML = `▲▼`;
            arrowEl.style.color = 'var(--text-muted)';
            arrowEl.style.opacity = '0.35';
            if (thEl) thEl.style.color = 'var(--text-secondary)';
        }
    });
}

function toggleSangttaOrderLock(e) {
    const cb = document.getElementById('sangtta-lock-checkbox');
    const label = document.getElementById('sangtta-lock-label');
    const wrapper = document.getElementById('sangtta-lock-wrapper');
    if (!cb) return;
    if (e && e.target && e.target.id !== 'sangtta-lock-checkbox') {
        cb.checked = !cb.checked;
    }
    isSangttaOrderLocked = cb.checked;
    if (isSangttaOrderLocked) {
        if (label) {
            label.innerText = "🔒 위치 고정 (눈고정 모드 ON)";
            label.style.color = "#e11d48";
        }
        if (wrapper) {
            wrapper.style.background = "#fff1f2";
            wrapper.style.borderColor = "#fecdd3";
        }
    } else {
        if (label) {
            label.innerText = "🔓 자동 순위 재정렬 모드 (OFF)";
            label.style.color = "var(--text-muted)";
        }
        if (wrapper) {
            wrapper.style.background = "#f8fafc";
            wrapper.style.borderColor = "var(--border-color)";
        }
        fetchAndRenderSangttaStocks(true);
    }
}

function buildSangttaRowHtml(stock, isExited = false) {
    let rateClass = 'flat';
    if (stock.rate > 0) rateClass = 'up';
    else if (stock.rate < 0) rateClass = 'down';

    const cleanRateStr = getFormattedRateStr(stock.rate_str, stock.rate);

    let sourcesHtml = '';
    if (stock.sources && stock.sources.length > 0) {
        sourcesHtml = stock.sources.map(s => {
            if (s === '네이버') return `<span style="background: #ecfdf5; color: #047857; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; border: 1px solid #a7f3d0; margin-bottom: 0.1rem; display: inline-flex; align-items: center; margin-right: 0.2rem;">⚡ 네이버</span>`;
            if (s === '로얄로더') return `<span style="background: #fffbeb; color: #b45309; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; border: 1px solid #fde68a; margin-bottom: 0.1rem; display: inline-flex; align-items: center; margin-right: 0.2rem;">👑 로얄로더</span>`;
            if (s === '토스') return `<span style="background: #eff6ff; color: #1d4ed8; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; border: 1px solid #bfdbfe; margin-bottom: 0.1rem; display: inline-flex; align-items: center; margin-right: 0.2rem;">🚀 토스</span>`;
            return `<span style="background: #f1f5f9; color: var(--text-secondary); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; margin-bottom: 0.1rem; margin-right: 0.2rem;">${s}</span>`;
        }).join('');
    }

    let themeTagsHtml = '';
    if (stock.themes && stock.themes.length > 0) {
        themeTagsHtml = stock.themes.map(t => 
            `<span style="background: #eff6ff; color: #1d4ed8; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; border: 1px solid #bfdbfe; display: inline-block; margin-bottom: 0.1rem;">${t}</span>`
        ).join(' ');
    } else {
        themeTagsHtml = '<span style="color: var(--text-muted); font-size: 0.7rem;">-</span>';
    }

    const rankDisplay = isExited ? `<span style="color:#94a3b8; font-size:0.7rem;">이탈</span>` : stock.rank;
    const nameExtra = isExited ? ` <span style="font-size:0.65rem; color:#ef4444; background:#fef2f2; padding:0.1rem 0.3rem; border-radius:4px; border:1px solid #fecdd3;">24% 미만 이탈</span>` : '';

    return `
        <td class="col-rank" style="padding: 0.75rem 0.5rem; text-align: center; font-weight: 800; color: #dc2626; font-family: var(--font-outfit);">
            ${rankDisplay}
        </td>
        <td class="col-name" style="padding: 0.75rem 0.5rem; font-weight: 700; color: var(--text-primary);">
            <div style="font-size: 0.85rem; font-weight: 700;">${stock.name}${nameExtra}</div>
            <div style="font-size: 0.65rem; color: var(--text-muted); margin-top: 0.1rem;">${stock.symbol}</div>
        </td>
        <td class="col-price" style="padding: 0.75rem 0.5rem; text-align: right; font-weight: 700; font-family: var(--font-outfit); font-size: 0.85rem; transition: background-color 0.3s;">
            ${stock.price_str}
        </td>
        <td class="col-rate ${rateClass}" style="padding: 0.75rem 0.5rem; text-align: right; font-weight: 800; font-family: var(--font-outfit); font-size: 0.85rem; transition: background-color 0.3s;">
            ${cleanRateStr}
        </td>
        <td class="col-volume" style="padding: 0.75rem 0.5rem; text-align: right; font-weight: 700; color: #4338ca; font-family: var(--font-outfit); font-size: 0.82rem;">
            ${stock.volume_str}
        </td>
        <td class="col-themes" style="padding: 0.75rem 0.7rem 0.75rem 1.5rem; text-align: left;">
            <div style="display: flex; flex-wrap: wrap; gap: 0.2rem; align-items: center;">
                ${sourcesHtml}
                ${themeTagsHtml}
            </div>
        </td>
        <td style="padding: 0.75rem 0.5rem; text-align: center;">
            <a href="${stock.toss_url}" target="_blank" style="padding: 0.35rem 0.65rem; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 6px; font-size: 0.72rem; font-weight: 700; text-decoration: none; display: inline-block; transition: all 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.05);" title="토스증권에서 주문">🚀 토스 주문</a>
        </td>
    `;
}

async function fetchAndRenderSangttaStocks(forceReorder = false, useLocalData = false) {
    const tbody = document.getElementById('sangtta-stock-tbody');
    const emptyMsg = document.getElementById('sangtta-view-empty-msg');
    if (!tbody) return;

    if (!useLocalData || !sangttaData || sangttaData.length === 0) {
        try {
            const response = await fetch('/api/v1/market/toss-sangtta');
            const result = await response.json();
            if (result.status === 'success') {
                sangttaData = result.data || [];
            } else {
                sangttaData = [];
            }
        } catch (e) {
            console.error("토스 상따 종목 로딩 실패:", e);
            sangttaData = [];
        }
    }

    // 선택된 정렬 기준에 맞게 데이터 재정렬 및 순위 번호 재부여
    if (sangttaData && sangttaData.length > 0) {
        sangttaData.sort((a, b) => {
            const valA = parseFloat(a[currentSangttaSortField]) || 0;
            const valB = parseFloat(b[currentSangttaSortField]) || 0;
            return currentSangttaSortAsc ? (valA - valB) : (valB - valA);
        });
        sangttaData.forEach((item, index) => {
            item.rank = index + 1;
        });
    }
    updateSangttaSortIcons();

    const isLocked = isSangttaOrderLocked && (forceReorder !== true);
    const existingRows = Array.from(tbody.querySelectorAll('tr[data-symbol]'));
    const hasExisting = existingRows.length > 0;

    // [초기 로드 / 수동 재정렬 / 눈고정 OFF 시] 깔끔한 새로 렌더링 (순위순 정렬 유지)
    if (!isLocked || !hasExisting) {
        tbody.innerHTML = '';
        if (sangttaData.length === 0) {
            if (emptyMsg) emptyMsg.style.display = 'block';
            return;
        }
        if (emptyMsg) emptyMsg.style.display = 'none';

        sangttaData.forEach(stock => {
            const tr = document.createElement('tr');
            tr.setAttribute('data-symbol', stock.symbol);
            tr.setAttribute('data-price', stock.price_str);
            tr.setAttribute('data-rate', stock.rate_str);
            tr.id = `sangtta-tr-${stock.symbol}`;
            tr.style.borderBottom = '1px solid var(--border-color)';
            tr.style.transition = 'background-color 0.15s, opacity 0.3s';
            tr.onmouseover = () => { tr.style.backgroundColor = '#fef2f2'; };
            tr.onmouseout = () => { tr.style.backgroundColor = 'transparent'; };

            tr.innerHTML = buildSangttaRowHtml(stock, false);
            tbody.appendChild(tr);
        });
        return;
    }

    // [위치 고정 (눈고정 모드 ON) - In-Place 실시간 업데이트]
    if (emptyMsg) emptyMsg.style.display = 'none';
    const newSymbolMap = new Map();
    sangttaData.forEach(stock => newSymbolMap.set(stock.symbol, stock));

    existingRows.forEach(tr => {
        const symbol = tr.getAttribute('data-symbol');
        const stock = newSymbolMap.get(symbol);

        if (stock) {
            tr.style.opacity = '1';
            const oldPrice = tr.getAttribute('data-price');
            const oldRate = tr.getAttribute('data-rate');

            const priceCell = tr.querySelector('.col-price');
            const rateCell = tr.querySelector('.col-rate');
            const volumeCell = tr.querySelector('.col-volume');

            let priceChanged = oldPrice && oldPrice !== stock.price_str;
            let rateChanged = oldRate && oldRate !== stock.rate_str;

            if (priceChanged && priceCell) {
                priceCell.innerText = stock.price_str;
                tr.setAttribute('data-price', stock.price_str);
                priceCell.classList.remove('cell-flash-up', 'cell-flash-down');
                void priceCell.offsetWidth;
                priceCell.classList.add('cell-flash-up');
            } else if (priceCell && priceCell.innerText !== stock.price_str) {
                priceCell.innerText = stock.price_str;
                tr.setAttribute('data-price', stock.price_str);
            }

            if (rateChanged && rateCell) {
                const rateVal = parseFloat(stock.rate);
                rateCell.className = `col-rate ${rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat')}`;
                rateCell.innerText = getFormattedRateStr(stock.rate_str, stock.rate);
                tr.setAttribute('data-rate', stock.rate_str);
                rateCell.classList.remove('cell-flash-up', 'cell-flash-down');
                void rateCell.offsetWidth;
                rateCell.classList.add(rateVal > 0 ? 'cell-flash-up' : 'cell-flash-down');
            } else if (rateCell) {
                const rateVal = parseFloat(stock.rate);
                rateCell.className = `col-rate ${rateVal > 0 ? 'up' : (rateVal < 0 ? 'down' : 'flat')}`;
                rateCell.innerText = getFormattedRateStr(stock.rate_str, stock.rate);
                tr.setAttribute('data-rate', stock.rate_str);
            }

            if (volumeCell) {
                volumeCell.innerText = stock.volume_str;
            }

            if (tr.getAttribute('data-exited') === 'true') {
                tr.removeAttribute('data-exited');
                tr.innerHTML = buildSangttaRowHtml(stock, false);
            }

            newSymbolMap.delete(symbol);
        } else {
            // 이번 주기에서 +24% 미만으로 내려가거나 리스트에서 제외된 종목 처리
            if (tr.getAttribute('data-exited') !== 'true') {
                tr.setAttribute('data-exited', 'true');
                tr.style.opacity = '0.55';
                const nameCell = tr.querySelector('.col-name');
                const rankCell = tr.querySelector('.col-rank');
                if (rankCell) rankCell.innerHTML = `<span style="color:#94a3b8; font-size:0.7rem;">이탈</span>`;
                if (nameCell && !nameCell.innerHTML.includes('24% 미만 이탈')) {
                    const nameDiv = nameCell.querySelector('div:first-child');
                    if (nameDiv) {
                        nameDiv.innerHTML += ` <span style="font-size:0.65rem; color:#ef4444; background:#fef2f2; padding:0.1rem 0.3rem; border-radius:4px; border:1px solid #fecdd3; display:inline-block; margin-top:0.1rem;">24% 미만 이탈</span>`;
                    }
                }
            }
        }
    });

    // 신규 진입 종목은 눈의 관찰 시야를 방해하지 않도록 테이블 최하단에 부드럽게 추가
    newSymbolMap.forEach(stock => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-symbol', stock.symbol);
        tr.setAttribute('data-price', stock.price_str);
        tr.setAttribute('data-rate', stock.rate_str);
        tr.id = `sangtta-tr-${stock.symbol}`;
        tr.className = 'row-new-entrant';
        tr.style.borderBottom = '1px solid var(--border-color)';
        tr.style.transition = 'background-color 0.15s, opacity 0.3s';
        tr.onmouseover = () => { tr.style.backgroundColor = '#fef2f2'; };
        tr.onmouseout = () => { tr.style.backgroundColor = 'transparent'; };

        tr.innerHTML = buildSangttaRowHtml(stock, false);
        const nameDiv = tr.querySelector('.col-name div:first-child');
        if (nameDiv) {
            nameDiv.innerHTML += ` <span style="font-size:0.65rem; background:#fef3c7; color:#b45309; padding:0.1rem 0.4rem; border-radius:4px; font-weight:800; border:1px solid #fde68a;">✨ NEW 진입</span>`;
        }

        tbody.appendChild(tr);
    });
}

function showStockNetworkMap(stockName, stockCode) {
    switchMainView('network');
    
    // Smooth scroll and flash highlight
    setTimeout(() => {
        const card = document.getElementById(`chart-card-${stockCode}`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('flash-chart-card-active');
            setTimeout(() => {
                card.classList.remove('flash-chart-card-active');
            }, 3000);
        }
    }, 300);
}

function renderLeaderCharts() {
    const container = document.getElementById('charts-grid-container');
    if (!container) return;

    // Destroy existing charts to prevent memory leaks
    Object.values(chartInstances).forEach(chart => {
        if (chart) chart.destroy();
    });
    chartInstances = {};
    container.innerHTML = '';

    if (!themesData || themesData.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted); font-size: 0.9rem;">수집된 테마 데이터가 아직 없습니다.</div>';
        return;
    }

    // Filter themes containing stock data, limit to top 8, then sort by 등락률 desc
    // 동일 종목이 여러 테마의 대장주로 잡힌 경우 중복 카드 대신 테마명을 통합
    const leaderMap = new Map();
    themesData.slice(0, 8)
        .map(theme => {
            if (!theme.top_stocks || theme.top_stocks.length === 0) return null;
            const stock = theme.top_stocks.find(s => s.role.includes("대장주") || s.role.includes("1등주")) || theme.top_stocks[0];
            return { theme, stock };
        })
        .filter(Boolean)
        .sort((a, b) => (parseFloat(b.stock.rate) || 0) - (parseFloat(a.stock.rate) || 0))
        .forEach(entry => {
            const key = entry.stock.stock_code;
            const existing = leaderMap.get(key);
            if (existing) {
                if (existing.themes.indexOf(entry.theme.theme_name) === -1) existing.themes.push(entry.theme.theme_name);
                return;
            }
            leaderMap.set(key, { theme: entry.theme, stock: entry.stock, themes: [entry.theme.theme_name] });
        });

    // 알림 종목으로 체크된 종목도 차트에 포함 (상위 8개 테마 밖이라도)
    alertEnabledCodes.forEach(code => {
        if (leaderMap.has(code)) return;
        for (const theme of themesData) {
            const stock = (theme.top_stocks || []).find(s => s.stock_code === code);
            if (stock) {
                leaderMap.set(code, { stock, themes: [theme.theme_name] });
                return;
            }
        }
    });

    const leaders = [...leaderMap.values()];

    leaders.forEach(({ theme, stock, themes }) => {
        // Decide colors
        const rateVal = parseFloat(stock.rate);
        let rateColor = 'var(--text-muted)';
        if (rateVal > 0) {
            rateColor = 'var(--accent-red)';
        } else if (rateVal < 0) {
            rateColor = 'var(--accent-blue)';
        }
        const cleanRateStr = getFormattedRateStr(stock.rate_str, rateVal);

        const drop = parseFloat(stock.drop);
        let dropColor = 'var(--text-muted)';
        if (drop < -8.0) dropColor = 'var(--accent-orange)';
        else if (drop < -4.4) dropColor = 'var(--accent-green)';

        // 3개월 수급 위치 (머리/어깨/무릎)
        const level = stock.price_level || '-';
        let levelColor = 'var(--text-muted)';
        let levelBg = 'rgba(100, 116, 139, 0.08)';
        if (level === '머리') { levelColor = '#ef4444'; levelBg = 'rgba(239, 68, 68, 0.08)'; }
        else if (level === '어깨') { levelColor = '#d97706'; levelBg = 'rgba(245, 158, 11, 0.08)'; }
        else if (level === '무릎') { levelColor = '#10b981'; levelBg = 'rgba(16, 185, 129, 0.08)'; }
        const levelPos = stock.price_position_ratio !== undefined ? `${stock.price_position_ratio}%` : '';

        // 10일/20일 이평선 정배열 여부
        const maGood = !!stock.ma10_above_ma20;
        const maColor = maGood ? '#10b981' : 'var(--text-muted)';
        const maBg = maGood ? 'rgba(16, 185, 129, 0.08)' : 'rgba(100, 116, 139, 0.08)';
        const maLabel = maGood ? '10MA ≥ 20MA' : '10MA < 20MA';

        // Create card element
        const card = document.createElement('div');
        card.className = 'chart-card' + (alertEnabledCodes.has(stock.stock_code) ? ' chart-card-alert' : '');
        card.id = `chart-card-${stock.stock_code}`;
        card.innerHTML = `
            <div class="chart-card-header">
                <div>
                    <span class="chart-theme-badge" title="${themes.join(' · ')}">${themes.join(' · ')}</span>
                    <div class="chart-stock-title">${stock.stock_name} ${alertEnabledCodes.has(stock.stock_code) ? '<span style="font-size:0.7rem;" title="알림 수신 종목">🔔</span>' : ''} <span class="chart-stock-code">${stock.stock_code}</span></div>
                    <div style="display: flex; gap: 0.3rem; margin-top: 0.35rem; flex-wrap: wrap;">
                        <span id="level-badge-${stock.stock_code}" style="font-size: 0.6rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 4px; color: ${levelColor}; background: ${levelBg}; border: 1px solid ${levelColor};" title="최근 3개월 수급 위치: ${levelPos} (${stock.price_level_desc || ''})">${level} ${levelPos}</span>
                        <span id="ma-badge-${stock.stock_code}" style="font-size: 0.6rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 4px; color: ${maColor}; background: ${maBg}; border: 1px solid ${maColor};" title="10일 vs 20일 이평선 정배열 여부">${maLabel}</span>
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 0.95rem; font-weight: 700; color: ${rateColor};">${stock.price_str}</div>
                    <div style="font-size: 0.72rem; font-weight: 600; color: ${rateColor};">${cleanRateStr}</div>
                </div>
            </div>
            <div class="chart-canvas-container">
                <canvas id="canvas-${stock.stock_code}"></canvas>
                <div class="chart-spinner" id="spinner-${stock.stock_code}">
                    <div class="spinner"></div>
                </div>
            </div>
            <div class="chart-card-footer">
                <div class="chart-day-info">
                    <div>당일 고점: <span id="day-high-${stock.stock_code}" style="font-weight: 700;">${stock.day_high_str || '-'}</span></div>
                    <div>당일 낙폭: <span id="day-drop-${stock.stock_code}" style="font-weight: 700; color: ${dropColor};">${stock.drop_str}</span></div>
                </div>
                <div class="chart-target-bands">
                    <span id="zone-1-${stock.stock_code}" class="band-pill zone-1">1차: ${stock.buy_zone_1}</span>
                    <span id="zone-2-${stock.stock_code}" class="band-pill zone-2">2차: ${stock.buy_zone_2}</span>
                </div>
            </div>
        `;
        container.appendChild(card);

        // Load chart asynchronously
        fetchAndDrawChart(stock.stock_code);
        // 3개월 수급 구간 가격대는 야후 파이낸스 기준으로 보정 표시
        fetchAndRenderPriceBands(stock.stock_code);
    });
}

async function fetchAndDrawChart(stockCode) {
    const spinner = document.getElementById(`spinner-${stockCode}`);
    const canvas = document.getElementById(`canvas-${stockCode}`);
    if (!canvas) return;

    try {
        const [chartRes, stats] = await Promise.all([
            fetch(`/api/v1/market/stocks/${stockCode}/chart`),
            loadStock3mStats(stockCode)
        ]);
        const result = await chartRes.json();

        if (spinner) spinner.style.display = 'none';

        if (result.status === 'success' && result.points && result.points.length > 0) {
            const ctx = canvas.getContext('2d');
            const prices = result.points.map(p => p.price);
            const labels = result.points.map(p => p.time);
            const prevClose = result.prevClose || prices[0];

            // Line Color (red for positive vs previous close or first price, blue for negative)
            const currentPrice = prices[prices.length - 1];
            const isPositive = currentPrice >= prevClose;
            const lineColor = isPositive ? 'rgba(239, 68, 68, 1)' : 'rgba(59, 130, 246, 1)';
            const fillColor = isPositive ? 'rgba(239, 68, 68, 0.05)' : 'rgba(59, 130, 246, 0.05)';

            // 머리/어깨/무릎 구간 오버레이 (가능할 때만, 뒤에 깔림)
            const band = compute3mBand(stats);
            const bandDatasets = buildBandDatasets(band, prices.length);
            const datasets = bandDatasets.concat({
                label: '주가',
                data: prices,
                borderColor: lineColor,
                borderWidth: 2,
                backgroundColor: fillColor,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.15
            });

            // Draw line chart
            const chart = new Chart(ctx, {
                type: 'line',
                data: { labels: labels, datasets: datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            backgroundColor: 'rgba(15, 23, 42, 0.85)',
                            titleFont: { size: 10, weight: 'bold' },
                            bodyFont: { size: 10 },
                            filter: function(item) { return item.datasetIndex === datasets.length - 1; },
                            callbacks: {
                                label: function(context) {
                                    return ` ${context.parsed.y.toLocaleString()}원`;
                                },
                                afterLabel: function() {
                                    if (!band) return '';
                                    const fmt = n => n.toLocaleString();
                                    const current = stats && stats.price_level ? stats.price_level : '—';
                                    return [
                                        '',
                                        `머리: ${fmt(band.headLow)} ~ ${fmt(band.high)}원`,
                                        `어깨: ${fmt(band.shoulderLow)} ~ ${fmt(band.headLow)}원`,
                                        `무릎: ${fmt(band.low)} ~ ${fmt(band.shoulderLow)}원`,
                                        `현재 수급: ${current}`
                                    ].join('\n');
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false },
                            ticks: {
                                maxRotation: 0,
                                autoSkip: true,
                                maxTicksLimit: 5,
                                font: { size: 8 }
                            }
                        },
                        y: {
                            grid: { color: 'rgba(0, 0, 0, 0.03)' },
                            afterBuildTicks: function(axis) {
                                // 머리/어깨 경계를 y축 눈금으로 주입
                                if (band) {
                                    axis.ticks.push({ value: band.headLow });
                                    axis.ticks.push({ value: band.shoulderLow });
                                }
                            },
                            ticks: {
                                font: { size: 8 },
                                color: function(context) {
                                    const v = context.tick.value;
                                    if (band && v === band.headLow) return '#ef4444';
                                    if (band && v === band.shoulderLow) return '#d97706';
                                    return undefined;
                                },
                                callback: function(value) {
                                    if (band && value === band.headLow) return `머리 ${value.toLocaleString()}`;
                                    if (band && value === band.shoulderLow) return `어깨 ${value.toLocaleString()}`;
                                    return value.toLocaleString();
                                }
                            }
                        }
                    }
                }
            });

            chartInstances[stockCode] = chart;

            // 당일 고점/낙폭 및 1차·2차 매수 구간을 차트(장중 5분봉) 데이터로 갱신
            if (result.dayHigh > 0) {
                const highSpan = document.getElementById(`day-high-${stockCode}`);
                if (highSpan) highSpan.textContent = `${result.dayHigh.toLocaleString()}원`;
                const dropSpan = document.getElementById(`day-drop-${stockCode}`);
                if (dropSpan && result.drop !== undefined) {
                    dropSpan.textContent = `${result.drop.toFixed(2)}%`;
                    let dropColor = 'var(--text-muted)';
                    if (result.drop < -8.0) dropColor = 'var(--accent-orange)';
                    else if (result.drop < -4.4) dropColor = 'var(--accent-green)';
                    dropSpan.style.color = dropColor;
                }
                // 매수 구간은 당일 고점 기준 1차(-4.4~-8%) / 2차(-8~-12%)
                const fmtWon = n => `${n.toLocaleString()}원`;
                const z1Low = Math.floor(result.dayHigh * 0.92), z1High = Math.floor(result.dayHigh * 0.956);
                const z2Low = Math.floor(result.dayHigh * 0.88), z2High = Math.floor(result.dayHigh * 0.92);
                const zone1Span = document.getElementById(`zone-1-${stockCode}`);
                if (zone1Span) zone1Span.textContent = `1차: ${fmtWon(z1Low)} ~ ${fmtWon(z1High)}`;
                const zone2Span = document.getElementById(`zone-2-${stockCode}`);
                if (zone2Span) zone2Span.textContent = `2차: ${fmtWon(z2Low)} ~ ${fmtWon(z2High)}`;
            }
        } else {
            drawEmptyChartMsg(canvas, '차트 데이터 없음');
        }
    } catch (e) {
        console.error(`Error loading chart for ${stockCode}:`, e);
        if (spinner) spinner.style.display = 'none';
        drawEmptyChartMsg(canvas, '로딩 실패');
    }
}

function drawEmptyChartMsg(canvas, msg) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = 'var(--text-muted)';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
}

const stock3mCache = new Map();

async function loadStock3mStats(stockCode) {
    if (stock3mCache.has(stockCode)) return stock3mCache.get(stockCode);
    try {
        const response = await fetch(`/api/v1/market/stocks/${stockCode}/stats-3m`);
        const result = await response.json();
        stock3mCache.set(stockCode, result.status === 'success' ? result : null);
    } catch (e) {
        console.error(`Error loading 3-month stats for ${stockCode}:`, e);
        stock3mCache.set(stockCode, null);
    }
    return stock3mCache.get(stockCode);
}

// 3개월 고가/저가로 머리·어깨 구간 경계(70%/35%)를 계산합니다. 데이터가 없으면 null.
function compute3mBand(stats) {
    if (!stats || !(stats.three_month_high > 0) || !(stats.three_month_low > 0)) return null;
    const high = stats.three_month_high;
    const low = stats.three_month_low;
    return {
        high: high,
        low: low,
        headLow: low + (high - low) * 0.7,
        shoulderLow: low + (high - low) * 0.35,
    };
}

// 차트 위에 머리/어깨/무릎 구간을 상수 라인 데이터셋(배경 채움 + 경계 점선)으로 그립니다.
function buildBandDatasets(band, n) {
    if (!band) return [];
    const base = { pointRadius: 0, pointHoverRadius: 0, borderWidth: 0, _isBand: true, fill: false };
    const fillArr = new Array(n).fill(null);
    return [
        { ...base, label: '3M 구간', data: fillArr.map(() => band.low), backgroundColor: 'rgba(148, 163, 184, 0.07)', fill: { target: 1 } },
        { ...base, label: '3M 상한', data: fillArr.map(() => band.high) },
        { ...base, label: '머리 하한', data: fillArr.map(() => band.headLow), borderColor: 'rgba(239, 68, 68, 0.65)', borderWidth: 1, borderDash: [4, 4] },
        { ...base, label: '어깨 하한', data: fillArr.map(() => band.shoulderLow), borderColor: 'rgba(217, 119, 6, 0.65)', borderWidth: 1, borderDash: [4, 4] },
    ];
}

async function fetchAndRenderPriceBands(stockCode) {
    const result = await loadStock3mStats(stockCode);
    if (!result) return;

    // 헤더의 수급 위치 뱃지 및 이평 뱃지 갱신
    const levelBadge = document.getElementById(`level-badge-${stockCode}`);
    if (levelBadge) {
        const lvl = result.price_level || '-';
        let lc = 'var(--text-muted)', lbg = 'rgba(100, 116, 139, 0.08)';
        if (lvl === '머리') { lc = '#ef4444'; lbg = 'rgba(239, 68, 68, 0.08)'; }
        else if (lvl === '어깨') { lc = '#d97706'; lbg = 'rgba(245, 158, 11, 0.08)'; }
        else if (lvl === '무릎') { lc = '#10b981'; lbg = 'rgba(16, 185, 129, 0.08)'; }
        levelBadge.style.color = lc;
        levelBadge.style.background = lbg;
        levelBadge.style.border = `1px solid ${lc}`;
        levelBadge.textContent = `${lvl} ${result.price_position_ratio !== undefined ? result.price_position_ratio + '%' : ''}`;
        levelBadge.title = `최근 3개월 수급 위치 (야후 파이낸스): ${result.price_position_ratio}% (${result.price_level_desc || ''})`;
    }
    const maBadge = document.getElementById(`ma-badge-${stockCode}`);
    if (maBadge) {
        const good = !!result.ma10_above_ma20;
        maBadge.style.color = good ? '#10b981' : 'var(--text-muted)';
        maBadge.style.background = good ? 'rgba(16, 185, 129, 0.08)' : 'rgba(100, 116, 139, 0.08)';
        maBadge.style.border = `1px solid ${good ? '#10b981' : 'var(--text-muted)'}`;
        maBadge.textContent = good ? '10MA ≥ 20MA' : '10MA < 20MA';
    }
}

// --- Hover Chart Tooltip ---
let hoverChartTimer = null;

function handleStockHover(event, stockCode, stockName) {
    clearTimeout(hoverChartTimer);
    const clientX = event.clientX;
    const clientY = event.clientY;
    hoverChartTimer = setTimeout(() => {
        showHoverChart(clientX, clientY, stockCode, stockName);
    }, 700);
}

function handleStockLeave() {
    clearTimeout(hoverChartTimer);
    const tooltip = document.getElementById('stock-hover-tooltip');
    if (tooltip) {
        tooltip.classList.remove('visible');
        setTimeout(() => {
            if (!tooltip.classList.contains('visible')) {
                tooltip.style.display = 'none';
            }
        }, 200);
    }
}

async function showHoverChart(clientX, clientY, stockCode, stockName) {
    const tooltip = document.getElementById('stock-hover-tooltip');
    const nameEl = document.getElementById('hover-stock-name');
    const codeEl = document.getElementById('hover-stock-code');
    
    if (!tooltip) return;
    
    nameEl.innerText = stockName;
    codeEl.innerText = stockCode;
    
    let top = clientY + 15;
    let left = clientX + 15;
    if (left + 380 > window.innerWidth) left = clientX - 395;
    if (top + 160 > window.innerHeight) top = clientY - 175;
    
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.display = 'block';
    
    setTimeout(() => tooltip.classList.add('visible'), 10);
    
    try {
        const stats = await loadStock3mStats(stockCode);
        
        if (!tooltip.classList.contains('visible') || codeEl.innerText !== stockCode) return;
        
        let targetStock = null;
        for (const theme of themesData) {
            if (theme.top_stocks) {
                targetStock = theme.top_stocks.find(s => s.stock_code === stockCode);
                if (targetStock) break;
            }
        }
        
        if (targetStock) {
            document.getElementById('hover-day-high').innerText = targetStock.day_high_str || '-';
            const dropEl = document.getElementById('hover-day-drop');
            dropEl.innerText = targetStock.drop_str || '-';
            const dropVal = parseFloat(targetStock.drop);
            dropEl.style.color = dropVal < -8.0 ? 'var(--accent-orange)' : (dropVal < -4.4 ? 'var(--accent-green)' : 'var(--text-muted)');
            
            document.getElementById('hover-zone-1').innerText = `1차: ${targetStock.buy_zone_1}`;
            document.getElementById('hover-zone-2').innerText = `2차: ${targetStock.buy_zone_2}`;
            
            const curPriceEl = document.getElementById('hover-current-price');
            if (curPriceEl) {
                curPriceEl.innerText = targetStock.price_str || '-';
            }
        }
        
        const lvlEl = document.getElementById('hover-stock-level');
        if (stats && lvlEl) {
            const level = stats.price_level || '-';
            const pos = stats.price_position_ratio !== undefined ? `${stats.price_position_ratio}%` : '';
            lvlEl.innerText = `${level} ${pos}`;
            if (level === '머리') { lvlEl.style.color = '#ef4444'; lvlEl.style.background = 'rgba(239, 68, 68, 0.08)'; lvlEl.style.border = '1px solid #ef4444'; }
            else if (level === '어깨') { lvlEl.style.color = '#d97706'; lvlEl.style.background = 'rgba(245, 158, 11, 0.08)'; lvlEl.style.border = '1px solid #d97706'; }
            else if (level === '무릎') { lvlEl.style.color = '#10b981'; lvlEl.style.background = 'rgba(16, 185, 129, 0.08)'; lvlEl.style.border = '1px solid #10b981'; }
            else { lvlEl.style.color = 'var(--text-muted)'; lvlEl.style.background = 'rgba(100, 116, 139, 0.08)'; lvlEl.style.border = '1px solid var(--text-muted)'; }
            
            const maEl = document.getElementById('hover-stock-ma');
            if (maEl) {
                const good = !!stats.ma10_above_ma20;
                maEl.innerText = good ? '10MA ≥ 20MA' : '10MA < 20MA';
                maEl.style.color = good ? '#10b981' : 'var(--text-muted)';
                maEl.style.background = good ? 'rgba(16, 185, 129, 0.08)' : 'rgba(100, 116, 139, 0.08)';
                maEl.style.border = `1px solid ${good ? '#10b981' : 'var(--text-muted)'}`;
            }
            
            const gaugeContainer = document.getElementById('hover-position-gauge-container');
            const gaugeMarker = document.getElementById('hover-gauge-marker');
            if (gaugeContainer && gaugeMarker && stats.price_position_ratio !== undefined) {
                gaugeContainer.style.display = 'block';
                gaugeMarker.style.transition = 'none';
                gaugeMarker.style.left = '0%';
                
                const gaugePriceEl = document.getElementById('hover-gauge-price');
                if (gaugePriceEl) {
                    gaugePriceEl.innerText = targetStock ? targetStock.price_str : '-';
                }
                
                setTimeout(() => {
                    gaugeMarker.style.transition = 'left 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
                    const ratio = Math.max(0, Math.min(100, stats.price_position_ratio));
                    gaugeMarker.style.left = `${ratio}%`;
                }, 10);
            } else if (gaugeContainer) {
                gaugeContainer.style.display = 'none';
            }
            
            const band = compute3mBand(stats);
            if (band) {
                const hEl = document.getElementById('hover-gauge-head');
                if (hEl) hEl.innerText = Math.round(band.headLow).toLocaleString();
                const sEl = document.getElementById('hover-gauge-shoulder');
                if (sEl) sEl.innerText = Math.round(band.shoulderLow).toLocaleString();
                const kEl = document.getElementById('hover-gauge-knee');
                if (kEl) kEl.innerText = Math.round(band.low).toLocaleString();
                const tEl = document.getElementById('hover-gauge-top');
                if (tEl) tEl.innerText = Math.round(band.high).toLocaleString();
            } else {
                const hEl = document.getElementById('hover-gauge-head');
                if (hEl) hEl.innerText = '-';
                const sEl = document.getElementById('hover-gauge-shoulder');
                if (sEl) sEl.innerText = '-';
                const kEl = document.getElementById('hover-gauge-knee');
                if (kEl) kEl.innerText = '-';
                const tEl = document.getElementById('hover-gauge-top');
                if (tEl) tEl.innerText = '-';
            }
        }
    } catch (e) {
        console.error('Hover fetch failed:', e);
    }
}

// --- Closing Price Betting Algorithm & UI ---
function renderClosingBetCandidates(themesData) {
    const section = document.getElementById('closing-bet-section');
    const container = document.getElementById('closing-bet-cards-container');
    if (!section || !container) return;

    const now = new Date();
    const timeInMins = now.getHours() * 60 + now.getMinutes();
    const isTargetTime = timeInMins >= (14 * 60 + 30) && timeInMins <= (15 * 60 + 30);
    
    // Get Top 8 themes by volume (themesData is already sorted)
    const topThemes = themesData.slice(0, 8);
    let candidates = [];
    
    topThemes.forEach((theme, themeIndex) => {
        if (!theme.top_stocks) return;
        const themeScore = 8 - themeIndex;
        const themeVolumeNum = parseFloat(theme.total_volume_str.replace(/[^0-9.]/g, '')) || 1;
        
        // Pick top 2 stocks from the theme
        const topStocks = theme.top_stocks.slice(0, 2);
        topStocks.forEach((stock) => {
            const rate = parseFloat(stock.rate) || 0;
            const drop = parseFloat(stock.drop) || 0;
            const volStr = stock.volume_str || '0';
            const vol = parseFloat(volStr.replace(/[^0-9.]/g, '')) || 0;
            
            let dominance = 0;
            if (themeVolumeNum > 0 && vol > 0) {
                dominance = Math.min(100, (vol / themeVolumeNum) * 100);
            }
            
            // Algorithm: Rate 7% ~ 25%, Drop 0 to -8%
            if (rate >= 7.0 && rate <= 25.0 && drop >= -8.0) {
                let score = rate + (dominance * 0.1) + themeScore;
                if (drop >= -5.0) score += 3; // Bonus for strong holding power
                if (vol > 300) score += 2; // Bonus for decent liquidity (>300억)
                
                candidates.push({ stock, themeName: theme.theme_name, score });
            }
        });
    });
    
    candidates.sort((a, b) => b.score - a.score);
    const finalCandidates = candidates.slice(0, 4);
    
    if (finalCandidates.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'flex';
    container.innerHTML = '';
    
    finalCandidates.forEach(c => {
        const s = c.stock;
        const rateClass = parseFloat(s.rate) >= 0 ? 'up' : 'down';
        const rateSign = parseFloat(s.rate) > 0 ? '+' : '';
        const glowClass = isTargetTime ? 'glow' : '';
        
        const card = document.createElement('div');
        card.className = `closing-bet-card ${glowClass}`;
        
        card.onmouseenter = (e) => handleStockHover(e, s.stock_code, s.stock_name);
        card.onmouseleave = handleStockLeave;
        
        // Allow clicking the card to open toss order link
        card.onclick = (e) => {
            e.stopPropagation();
            window.open(`https://www.tossinvest.com/stocks/A${s.stock_code}/order`, '_blank');
        };
        
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <span style="font-size: 0.7rem; font-weight: 700; color: var(--accent-blue); background: rgba(29, 78, 216, 0.1); padding: 0.2rem 0.4rem; border-radius: 4px;">${c.themeName} 대장</span>
                <span style="font-size: 0.7rem; color: var(--text-muted);">${s.volume_str || '-'}</span>
            </div>
            <div style="display: flex; align-items: baseline; gap: 0.5rem; margin-top: 0.2rem;">
                <span style="font-size: 1.1rem; font-weight: 800; color: var(--text-primary);">${s.stock_name}</span>
                <span style="font-size: 0.85rem; font-weight: 700;" class="${rateClass}">${rateSign}${s.rate}%</span>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.2rem; margin-top: 0.3rem;">
                <div style="display: flex; justify-content: space-between;">
                    <span>당일 고점 대비 낙폭:</span>
                    <span style="font-weight: 700; color: ${parseFloat(s.drop) < -5 ? 'var(--accent-orange)' : 'var(--accent-green)'};">${s.drop}%</span>
                </div>
                <div style="display: flex; justify-content: space-between; border-top: 1px dotted rgba(255,255,255,0.1); padding-top: 0.3rem; margin-top: 0.2rem;">
                    <span>눌림목 1차 타점:</span>
                    <span style="font-weight: 700; color: var(--text-muted);">${s.buy_zone_1 || '-'}</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}