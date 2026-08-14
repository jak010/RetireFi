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
let myHoldingSymbols = new Set();

async function fetchHoldingsSymbols() {
    try {
        const response = await fetch('/api/v1/market/holdings/symbols');
        const result = await response.json();
        if (result.status === 'success' && Array.isArray(result.data)) {
            myHoldingSymbols = new Set(result.data);
        }
    } catch (error) {
        console.error("보유 종목 심볼 로드 실패:", error);
    }
}

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

            if (activeMainView === 'stock') renderConsolidatedStocks();
            else if (activeMainView === 'sangtta') fetchAndRenderSangttaStocks();

            if (currentGridViewMode === 'heatmap') renderHeatmap();

            renderLeaderSectorsList();

            fetchTossRanking();
        } else if (result.status === 'loading') {
            // 백엔드의 실제 연산 진행 상태 표시
            const progress = result.progress || 0;
            const step = result.step || '';
            let stepText = '실시간 시세 연산 중...';
            
            if (step === 'mapping') {
                stepText = '네이버 금융 테마 매핑 데이터 수집 중...';
            } else if (step === 'stats') {
                stepText = '종목별 실시간 시세 및 4개월 통계 분석 중...';
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
    const sourceFilter = document.getElementById('filter-source') ? document.getElementById('filter-source').value : 'all';
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

        // Source filter
        if (sourceFilter === 'naver' && (theme.source !== 'naver' && theme.source !== 'both')) return false;
        if (sourceFilter === 'royal' && (theme.source !== 'royal' && theme.source !== 'both')) return false;
        if (sourceFilter === 'both' && theme.source !== 'both') return false;

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
            const escapedName = theme.theme_name.replace(/"/g, '\\"');
            const targetCard = document.querySelector(`.theme-card[data-theme-name="${escapedName}"]`);
            if (targetCard) {
                targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                // Highlight the card temporarily
                const originalBoxShadow = targetCard.style.boxShadow;
                targetCard.style.transition = 'box-shadow 0.4s ease';
                targetCard.style.boxShadow = '0 0 0 3px var(--accent-blue)';
                setTimeout(() => {
                    targetCard.style.boxShadow = originalBoxShadow;
                }, 1500);
            }
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
        if (currentGridViewMode === 'detail') renderDashboard();
        else renderHeatmap();
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
    if (!container) return;

    // Save scroll states to prevent jumping on refresh
    const mainScrollY = window.scrollY || document.documentElement.scrollTop;
    const cardScrolls = {};
    document.querySelectorAll('.theme-card-body').forEach(body => {
        const card = body.closest('.theme-card');
        if (card) {
            const cardId = card.getAttribute('data-theme-name');
            if (cardId) cardScrolls[cardId] = body.scrollTop;
        }
    });

    const searchBox = document.getElementById('search-box');
    const searchVal = searchBox.value.trim().toLowerCase();
    const rateFilter = document.getElementById('filter-rate').value;
    const volFilter = document.getElementById('filter-volume').value;
    const targetFilter = document.getElementById('filter-target').value;
    const sourceFilter = document.getElementById('filter-source') ? document.getElementById('filter-source').value : 'all';
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
    
    const hasActiveFilters = searchVal !== '' || rateFilter !== 'all' || volFilter !== 'all' || targetFilter !== 'all' || sourceFilter !== 'all';

    // Toggle search clear button based on active filter state
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = hasActiveFilters ? 'flex' : 'none';
    }

    if (!hasActiveFilters) {
        // If there are no active filters, render top 20 themes to allow grouping
        displayThemes = processedThemes.slice(0, 20);
        headerMsg = `⚡ 실시간 거래대금 상위 TOP 20 테마군`;
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

    const getRoleWeight = (role) => {
        if (!role) return 0;
        if (role.includes("대장주")) return 3;
        if (role === "🥇 1등주") return 2;
        if (role === "🥈 2등주") return 1;
        return 0;
    };

    const formatVolume = (vol) => {
        if (vol >= 1000000000000) return (vol / 1000000000000).toFixed(1) + '조';
        if (vol >= 100000000) return Math.floor(vol / 100000000).toLocaleString() + '억';
        return vol.toLocaleString();
    };

    const appendThemeGroupCard = (group, isMultiGroup) => {
        const leader = group.leader;
        const themes = group.themes;
        
        let sumRate = 0;
        let sumVolume = 0;
        let sumMapped = 0;
        let sumTotal = 0;
        let sumUp = 0;
        let sumDown = 0;
        let sumFlat = 0;
        let sumVolShare = 0;
        
        let hasNaver = false;
        let hasRoyal = false;
        
        let hasAlert1 = false;
        let hasAlert2 = false;

        themes.forEach(theme => {
            sumRate += parseFloat(theme.avg_rate) || 0;
            sumVolume += theme.total_volume || 0;
            sumMapped += theme.mapped_count || 0;
            sumTotal += theme.total_count || 0;
            sumUp += theme.up_count || 0;
            sumDown += theme.down_count || 0;
            sumFlat += theme.flat_count || 0;
            sumVolShare += parseFloat(theme.volume_share) || 0;
            
            if (theme.source === 'naver') hasNaver = true;
            if (theme.source === 'royal') hasRoyal = true;
            if (theme.source === 'both') { hasNaver = true; hasRoyal = true; }
            
            if (theme.top_stocks) {
                theme.top_stocks.forEach(stock => {
                    const drop = parseFloat(stock.drop);
                    if (stock.role.includes("대장주") || stock.role === "🥇 1등주") {
                        if (drop >= -8.0 && drop <= -4.4) hasAlert1 = true;
                        else if (drop >= -12.0 && drop < -8.0) hasAlert2 = true;
                    }
                });
            }
        });
        
        const avgRate = (sumRate / themes.length).toFixed(2);
        const rateVal = parseFloat(avgRate);
        let rateClass = 'flat';
        let rateSign = '';
        if (rateVal > 0) {
            rateClass = 'up';
            rateSign = '+';
        } else if (rateVal < 0) {
            rateClass = 'down';
        }

        // Render Themes inside Body
        let themesHtml = '';
        themes.forEach((theme, index) => {
            let stocksHtml = '';
            if (theme.top_stocks && theme.top_stocks.length > 0) {
                let maxVolStockCode = null;
                let maxVol = -1;
                theme.top_stocks.forEach(s => {
                    let vol = s.volume || 0;
                    if (vol > maxVol) {
                        maxVol = vol;
                        maxVolStockCode = s.stock_code;
                    }
                });

                // Limit to top 3 stocks per nested theme
                theme.top_stocks.slice(0, 3).forEach(stock => {
                    const isLeader = stock.role && stock.role.includes("대장주");
                    const is1st = stock.role === "🥇 1등주";
                    
                    let roleIcon = '▪️';
                    if (isLeader) roleIcon = '👑';
                    else if (is1st) roleIcon = '🥇';
                    else if (stock.role === "🥈 2등주") roleIcon = '🥈';

                    let rowClass = '';
                    if (isLeader) rowClass = 'leader';
                    else if (is1st) rowClass = 'first';

                    const isVolumeLeader = (stock.stock_code === maxVolStockCode && maxVolStockCode !== null);
                    if (isVolumeLeader) {
                        rowClass += ' volume-leader';
                    }

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

                    const drop = parseFloat(stock.drop);
                    let buyZoneClass = '';
                    
                    if (isLeader || is1st) {
                        if (drop >= -8.0 && drop <= -4.4) {
                            buyZoneClass = 'zone-1';
                            totalBuyingTargets++;
                        } else if (drop >= -12.0 && drop < -8.0) {
                            buyZoneClass = 'zone-2';
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
                                    ${isVolumeLeader ? '<span class="volume-leader-badge">주도주</span>' : ''}
                                </div>
                                <div style="font-size: 0.7rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.25rem; margin-top: 0.2rem;">
                                    <span style="color: var(--text-muted);">대금:</span>
                                    <span style="font-weight: 500;">${stock.volume_str || '-'}</span>
                                    <button onclick="openNewsModal('${stock.stock_code}', '${stock.stock_name}')" style="margin-left: auto; padding: 0.15rem 0.4rem; background: #fff7ed; color: #ea580c; border: 1px solid #fdba74; border-radius: 4px; font-size: 0.6rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 0.15rem; transition: all 0.2s ease; box-shadow: 0 1px 2px rgba(234, 88, 12, 0.05);" onmouseover="this.style.background='#ffedd5'; this.style.borderColor='#fb923c';" onmouseout="this.style.background='#fff7ed'; this.style.borderColor='#fdba74';" title="네이버 증권 뉴스 및 공시 보기"><span style="font-size: 0.65rem;">📰</span> 뉴스</button>
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
                stocksHtml = `<div style="text-align:center; padding:0.5rem; color:var(--text-muted); font-size:0.75rem;">활성 종목이 존재하지 않습니다.</div>`;
            }

            const themeRateVal = parseFloat(theme.avg_rate);
            let tRateClass = 'flat';
            let tRateSign = '';
            if (themeRateVal > 0) { tRateClass = 'up'; tRateSign = '+'; }
            else if (themeRateVal < 0) { tRateClass = 'down'; }
            
            themesHtml += `
                <div class="nested-theme-section" style="${index > 0 ? 'margin-top: 1rem; padding-top: 1rem; border-top: 1px dashed var(--border-color);' : ''}">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem;">
                        <span style="font-size: 0.85rem; font-weight: 800; color: var(--text-primary); border-left: 3px solid var(--accent-blue); padding-left: 0.4rem;">${theme.theme_name}</span>
                        <div style="display: flex; align-items: baseline; gap: 0.5rem; font-size: 0.75rem;">
                            <span class="${tRateClass}" style="font-weight: 700;">${tRateSign}${theme.avg_rate}%</span>
                            <span style="color: var(--text-muted); font-size: 0.7rem;">${theme.total_volume_str.split(" ")[0]}</span>
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 0.45rem;">
                        ${stocksHtml}
                    </div>
                </div>
            `;
        });

        const cardId = isMultiGroup ? `group-${leader}` : `theme-${themes[0].theme_name}`;

        if (hasAlert1 || hasAlert2) {
            expandedStateMap[cardId] = true;
        } else if (expandedStateMap[cardId] === undefined) {
            expandedStateMap[cardId] = true;
        }
        const isExpanded = expandedStateMap[cardId];

        let sourceBadgeHtml = '';
        if (hasRoyal && !hasNaver) {
            sourceBadgeHtml = `<span class="theme-source-badge royal" style="font-size: 0.65rem; background: var(--accent-blue-glow); color: var(--accent-blue); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(29, 78, 216, 0.2);">로얄</span>`;
        } else if (hasNaver && !hasRoyal) {
            sourceBadgeHtml = `<span class="theme-source-badge naver" style="font-size: 0.65rem; background: rgba(16, 185, 129, 0.08); color: var(--accent-green); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.2);">네이버</span>`;
        } else if (hasNaver && hasRoyal) {
            sourceBadgeHtml = `<span class="theme-source-badge both" style="font-size: 0.65rem; background: linear-gradient(90deg, rgba(16, 185, 129, 0.15) 0%, rgba(29, 78, 216, 0.15) 100%); color: var(--text-primary); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 800; border: 1px solid rgba(255, 255, 255, 0.15);">🟢 네이버 + 🔵 로얄</span>`;
        }

        let alertBadgeHtml = '';
        if (hasAlert1) {
            alertBadgeHtml = `<span class="theme-alert-badge alert-1" style="font-size: 0.65rem; background: rgba(16, 185, 129, 0.12); color: var(--accent-green); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.25); margin-left: 0.25rem; display: inline-flex; align-items: center; gap: 2px;">🟢 1차 낙폭</span>`;
        } else if (hasAlert2) {
            alertBadgeHtml = `<span class="theme-alert-badge alert-2" style="font-size: 0.65rem; background: rgba(217, 119, 6, 0.12); color: var(--accent-orange); padding: 0.15rem 0.35rem; border-radius: 4px; font-weight: 700; border: 1px solid rgba(217, 119, 6, 0.25); margin-left: 0.25rem; display: inline-flex; align-items: center; gap: 2px;">🟠 2차 낙폭</span>`;
        }

        const themeNames = themes.map(t => t.theme_name).join(', ');
        const cardTitle = isMultiGroup ? `👑 ${leader} 주도 그룹` : themes[0].theme_name;
        const cardSubtitleHtml = isMultiGroup ? `<div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.35rem; word-break: keep-all; line-height: 1.3;"><span style="font-weight:600; color:var(--text-primary);">포함 테마 (${themes.length}개):</span> ${themeNames}</div>` : '';

        const card = document.createElement('div');
        card.className = `theme-card ${isExpanded ? 'expanded' : ''} ${hasAlert1 ? 'has-alert-1' : ''} ${hasAlert2 ? 'has-alert-2' : ''}`;
        card.setAttribute('data-theme-name', cardId);

        card.innerHTML = `
            <div class="theme-card-header" onclick="toggleCard('${cardId}')">
                <div class="theme-title-block" style="flex: 1; padding-right: 1rem;">
                    <div style="display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">
                        <span class="theme-card-title">${cardTitle}</span>
                        ${sourceBadgeHtml}
                        ${alertBadgeHtml}
                    </div>
                    <span class="theme-card-subtitle" style="display: flex; flex-direction: column; gap: 0.15rem; margin-top: 0.25rem;">
                        <span>종목 매핑: ${sumMapped} / ${sumTotal} (누적)</span>
                        <span style="font-size: 0.72rem; color: var(--text-muted);">
                            상승 <span style="color: var(--accent-red); font-weight: 600;">▲${sumUp}</span> | 
                            하락 <span style="color: var(--accent-blue); font-weight: 600;">▼${sumDown}</span>
                            ${sumFlat ? ` | 보합 ${sumFlat}` : ''}
                        </span>
                    </span>
                    ${cardSubtitleHtml}
                </div>
                <div class="theme-card-metrics" style="align-items: flex-end;">
                    <span class="theme-card-rate ${rateClass}">${rateSign}${avgRate}%</span>
                    <span class="theme-card-volume">
                        ${formatVolume(sumVolume)}
                        <span class="theme-share-badge">${sumVolShare.toFixed(1)}%</span>
                    </span>
                </div>
            </div>
            <div class="theme-card-body" style="max-height: 380px; overflow-y: auto; overflow-x: hidden; padding-right: 0.5rem;">
                ${themesHtml}
            </div>
        `;

        container.appendChild(card);
    };

    // Grouping by leader_stock
    const leaderGroups = {};
    displayThemes.forEach(theme => {
        const leader = theme.leader_stock || "N/A";
        // Prevent grouping unrelated themes that happen to have no leader stock
        const groupKey = (leader === "N/A" || !leader.trim() || leader === "-") ? `_unique_${theme.theme_name}` : leader;
        
        if (!leaderGroups[groupKey]) {
            leaderGroups[groupKey] = {
                leader: leader,
                themes: [],
                totalVolume: 0
            };
        }
        leaderGroups[groupKey].themes.push(theme);
        leaderGroups[groupKey].totalVolume += theme.total_volume || 0;
    });

    // Convert to array and sort
    // 1순위: 테마 개수 (내림차순)
    // 2순위: 그룹 내 테마들의 총 거래대금 (내림차순)
    const sortedGroups = Object.values(leaderGroups).sort((a, b) => {
        if (b.themes.length !== a.themes.length) {
            return b.themes.length - a.themes.length;
        }
        return b.totalVolume - a.totalVolume;
    });

    if (sortedGroups.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = "grid-column: 1 / -1; text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.85rem; background: var(--bg-card); border-radius: 8px; border: 1px dashed var(--border-color);";
        emptyMsg.innerHTML = "수집된 테마 데이터가 없습니다.";
        container.appendChild(emptyMsg);
    } else {
        const multiGroups = sortedGroups.filter(g => g.themes.length > 1);
        const singleGroups = sortedGroups.filter(g => g.themes.length === 1);
        
        // 당일 등락률이 높은 순서대로 개별 주도테마 정렬
        singleGroups.sort((a, b) => {
            const rateA = parseFloat(a.themes[0].avg_rate) || 0;
            const rateB = parseFloat(b.themes[0].avg_rate) || 0;
            return rateB - rateA;
        });
        
        let isFirstGroup = true;
        
        // 1. Render Multi Groups (핫 테마군 - 병합된 단일 카드)
        if (multiGroups.length > 0) {
            const multiHeader = document.createElement('div');
            multiHeader.style.cssText = `grid-column: 1 / -1; font-size: 0.95rem; font-weight: 700; color: var(--accent-blue); padding: 0.5rem 0 0.4rem 0; margin-top: ${isFirstGroup ? '0.25rem' : '1.5rem'}; border-bottom: 2px solid rgba(29, 78, 216, 0.3); display: flex; align-items: center; gap: 0.5rem; letter-spacing: -0.02em;`;
            multiHeader.innerHTML = `🔥 복합 주도 테마군 (대장주 묶음) <span style="font-size: 0.8rem; font-weight: 500; color: var(--text-muted); margin-left: 0.5rem;">- ${multiGroups.length}개 묶음</span>`;
            container.appendChild(multiHeader);
            isFirstGroup = false;

            multiGroups.forEach(group => {
                appendThemeGroupCard(group, true);
            });
        }

        // 2. Render Single Groups (개별 테마)
        if (singleGroups.length > 0) {
            const singleHeader = document.createElement('div');
            singleHeader.style.cssText = `grid-column: 1 / -1; font-size: 0.95rem; font-weight: 700; color: var(--accent-green); padding: 0.5rem 0 0.4rem 0; border-bottom: 2px solid rgba(16, 185, 129, 0.3); margin-top: ${isFirstGroup ? '0.25rem' : '1.5rem'}; display: flex; align-items: center; gap: 0.5rem; letter-spacing: -0.02em;`;
            singleHeader.innerHTML = `💎 개별 주도 테마 <span style="font-size: 0.8rem; font-weight: 500; color: var(--text-muted); margin-left: 0.5rem;">- 단일 섹터 ${singleGroups.length}개</span>`;
            container.appendChild(singleHeader);
            
            singleGroups.forEach(group => {
                appendThemeGroupCard(group, false);
            });
        }
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
    
    // Also re-render the sidebar ranking in case themesData (for strong-theme filter) just loaded
    if (typeof renderTossSidebarRanking === 'function') {
        renderTossSidebarRanking();
    }

    // Restore scroll states
    requestAnimationFrame(() => {
        window.scrollTo(0, mainScrollY);
        document.querySelectorAll('.theme-card-body').forEach(body => {
            const card = body.closest('.theme-card');
            if (card) {
                const cardId = card.getAttribute('data-theme-name');
                if (cardId && cardScrolls[cardId] !== undefined) {
                    body.scrollTop = cardScrolls[cardId];
                }
            }
        });
    });
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
    if (document.getElementById('filter-source')) {
        document.getElementById('filter-source').value = 'all';
    }
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
    fetchHoldingsSymbols();
    fetchThemes();
    updateClock();
    setInterval(updateClock, 1000);
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
    
    const tabHoldings = document.getElementById('ticker-tab-holdings');
    const wrapperHoldings = document.getElementById('holdings-news-chips');
    
    [tabNews, tabToss, tabAlerts, tabHoldings].forEach(tab => {
        if (tab) tab.classList.remove('active');
    });
    [wrapperNews, wrapperToss, wrapperAlerts, wrapperHoldings].forEach(wrap => {
        if (wrap) wrap.style.display = 'none';
    });
    if (filterPills) filterPills.style.display = 'none';
    
    if (tabName !== 'holdings') {
        if (typeof stopHoldingsNewsTimer === 'function') stopHoldingsNewsTimer();
    }
    
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
    } else if (tabName === 'holdings') {
        if (tabHoldings) tabHoldings.classList.add('active');
        if (wrapperHoldings) wrapperHoldings.style.display = 'flex';
        if (typeof fetchHoldingsNews === 'function') {
            fetchHoldingsNews();
            startHoldingsNewsTimer();
        }
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
                } else if (currentTickerTab === 'holdings') {
                    titleEl.innerText = '💼 내 주식 실시간 뉴스';
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
            } else if (tabName === 'holdings') {
                titleEl.innerText = '💼 내 주식 실시간 뉴스';
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
    } else if (currentTickerTab === 'holdings') {
        previewEl.innerHTML = `💼 <span class="preview-highlight">내 주식 실시간 뉴스:</span> 랜덤 주기로 뉴스가 자동 갱신됩니다 &nbsp;&nbsp;|&nbsp;&nbsp; 💡 탭하여 전체 뉴스 보기`;
    } else {
        previewEl.innerHTML = `📢 실시간 주요 속보 및 Toss 인기 거래 순위를 확인하세요.`;
    }
}

// Toggle sidebar collapse/expand
let isSidebarCollapsed = false;
function toggleSidebar() {
    isSidebarCollapsed = !isSidebarCollapsed;
    const sidebar = document.querySelector('.ranking-sidebar');
    const layout = document.querySelector('.dashboard-layout');
    const btn = document.getElementById('btn-toggle-sidebar-left');
    
    if (isSidebarCollapsed) {
        layout.style.gridTemplateColumns = '0px 1fr';
        btn.innerText = '▶';
        btn.title = '사이드바 펴기';
        btn.style.position = 'absolute';
        btn.style.left = '0';
        btn.style.top = '140px';
        btn.style.zIndex = '100';
        btn.style.background = '#fff';
        btn.style.border = '1px solid var(--border-color)';
        btn.style.padding = '0.3rem';
        btn.style.borderRadius = '0 6px 6px 0';
        btn.style.boxShadow = '2px 0 5px rgba(0,0,0,0.05)';
        
        // Append the button to the layout directly so it stays visible
        layout.appendChild(btn);
    } else {
        layout.style.gridTemplateColumns = '320px 1fr';
        btn.innerText = '◀';
        btn.title = '사이드바 접기';
        btn.style.position = 'static';
        btn.style.background = 'none';
        btn.style.border = 'none';
        btn.style.boxShadow = 'none';
        btn.style.padding = '0';
        
        // Put the button back to the tabs container
        const tabsContainer = document.querySelector('.sidebar-tabs');
        if (tabsContainer) {
            tabsContainer.appendChild(btn);
        }
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

// Render Leader Sectors Top 3 List in horizontal banner
function renderLeaderSectorsList() {
    const bannerContainer = document.getElementById('leader-banner-container');
    const container = document.getElementById('leader-list-horizontal');
    if (!container || !bannerContainer) return;
    
    container.innerHTML = '';
    if (!Array.isArray(leaderSectors3) || leaderSectors3.length === 0) {
        bannerContainer.style.display = 'none';
        return;
    }
    
    bannerContainer.style.display = 'flex';
    
    leaderSectors3.forEach((theme, index) => {
        const item = document.createElement('div');
        item.style.cssText = `
            display: flex;
            align-items: center;
            gap: 0.5rem;
            background: #fff;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 0.25rem 0.6rem;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
            transition: all 0.2s;
            white-space: nowrap;
        `;
        
        const rateVal = parseFloat(theme.avg_rate);
        let rateColor = 'var(--text-muted)';
        if (rateVal > 0) rateColor = 'var(--accent-red)';
        else if (rateVal < 0) rateColor = 'var(--accent-blue)';
        
        item.innerHTML = `
            <div style="font-weight: 800; color: var(--text-secondary); font-size: 0.75rem;">${index + 1}</div>
            <div style="font-weight: 700; color: var(--text-primary); font-size: 0.75rem;">${theme.theme_name}</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);">대장: ${theme.leader_stock || '-'}</div>
            <div style="font-weight: 700; font-family: var(--font-outfit); font-size: 0.75rem; color: ${rateColor};">${rateVal > 0 ? '+' : ''}${theme.avg_rate}%</div>
        `;
        
        item.onmouseover = () => {
            item.style.transform = 'translateY(-1px)';
            item.style.boxShadow = '0 3px 5px rgba(0,0,0,0.05)';
        };
        item.onmouseout = () => {
            item.style.transform = 'translateY(0)';
            item.style.boxShadow = '0 1px 2px rgba(0,0,0,0.02)';
        };
        
        item.onclick = () => {
            triggerSearch(theme.theme_name);
        };
        
        container.appendChild(item);
    });
}



let currentConsolidatedSortField = 'theme_rate'; // 'price', 'rate', 'volume', 'drop', 'theme_rate'
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
    ['price', 'rate', 'volume', 'drop', 'theme_rate'].forEach(f => {
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

async function renderTechPanel(stockList) {
    const techPanel = document.getElementById('tech-panel-content');
    if (!techPanel) return;
    
    if (stockList.length > 0) {
        const symbols = stockList.map(s => s.code).join(',');
        try {
            const res = await fetch(`/api/v1/market/prices?symbols=${symbols}`);
            const json = await res.json();
            if (json.status === 'success' && json.data) {
                const priceMap = {};
                json.data.forEach(p => {
                    priceMap[p.symbol] = parseInt(p.lastPrice, 10);
                });
                stockList.forEach(s => {
                    if (priceMap[s.code]) {
                        s.price = priceMap[s.code];
                        s.price_str = s.price.toLocaleString() + '원';
                        
                        const rowPriceEl = document.querySelector(`#consolidated-row-${s.code} td:nth-child(2) span`);
                        if (rowPriceEl) {
                            rowPriceEl.innerText = s.price_str;
                        }
                    }
                });
            }
        } catch (e) {
            console.error("Toss 현재가 조회 실패:", e);
        }
    }
    
    const currentCardIds = Array.from(techPanel.children).map(c => c.id).filter(id => id.startsWith('tech-card-'));
    const newCardIds = stockList.map(s => `tech-card-${s.code}`);
    const isSameList = currentCardIds.length === newCardIds.length && currentCardIds.every((id, i) => id === newCardIds[i]);
    
    if (!isSameList) {
        let html = '';
        stockList.forEach(stock => {
            const id = `tech-card-${stock.code}`;
            const isHolding = myHoldingSymbols.has(stock.code);
            const cardBorder = isHolding ? '2px solid #eab308' : '1px solid var(--border-color)';
            const cardBg = isHolding ? '#fefce8' : '#fafafa';
            const holdingBadge = isHolding ? `<span style="font-size: 0.6rem; background: #eab308; color: white; padding: 0.15rem 0.3rem; border-radius: 4px; margin-left: 0.3rem; font-weight: 700; vertical-align: middle;">내 주식</span>` : '';
            
            html += `
                <div id="${id}" style="border: ${cardBorder}; border-radius: 8px; padding: 0.8rem; background: ${cardBg}; display: flex; flex-direction: column; gap: 0.5rem; transition: all 0.2s; ${isHolding ? 'box-shadow: 0 4px 6px rgba(234, 179, 8, 0.1);' : ''}">
                    <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid rgba(0,0,0,0.05); padding-bottom: 0.3rem;">
                        <div style="font-weight: 800; font-size: 0.95rem; color: var(--text-primary); cursor: pointer;" onclick="document.getElementById('consolidated-row-${stock.code}')?.scrollIntoView({behavior: 'smooth'})" title="표에서 해당 종목으로 이동">${stock.name}${holdingBadge} <span style="font-size: 0.7rem; color: var(--text-muted);">${stock.code}</span></div>
                        <div id="${id}-price" style="font-weight: 800; font-size: 0.95rem; font-family: var(--font-outfit);">${stock.price_str}</div>
                    </div>
                    <div id="${id}-loading" style="font-size: 0.7rem; color: var(--text-muted); text-align: center; margin: 0.8rem 0;">데이터 수집 및 분석 중...</div>
                    <div id="${id}-content" style="display: none; flex-direction: column; gap: 0.7rem;"></div>
                </div>
            `;
        });
        techPanel.innerHTML = html || '<div style="text-align: center; color: var(--text-muted); font-size: 0.75rem; margin-top: 2rem;">조건에 맞는 종목이 없습니다.</div>';
    } else {
        stockList.forEach(stock => {
            const priceEl = document.getElementById(`tech-card-${stock.code}-price`);
            if (priceEl) priceEl.innerText = stock.price_str;
        });
    }
    
    // Stagger API calls to prevent bombarding the backend and Naver Finance
    let delayCounter = 0;
    stockList.forEach((stock) => {
        const fetchAndRender = () => {
            loadStock4mStats(stock.code).then(stats => {
                const cardLoading = document.getElementById(`tech-card-${stock.code}-loading`);
                const cardContent = document.getElementById(`tech-card-${stock.code}-content`);
            if (!cardLoading || !cardContent) return;
            
            cardLoading.style.display = 'none';
            if (!stats) {
                cardContent.innerHTML = `<div style="font-size: 0.7rem; color: var(--text-muted); text-align: center;">데이터 없음</div>`;
                cardContent.style.display = 'flex';
                return;
            }
            
            const align = stats.ma_alignment || '-';
            const goodAlign = align.includes('정배열');
            const badAlign = align.includes('역배열');
            const maStyle = goodAlign ? 'background: rgba(16, 185, 129, 0.08); color: #10b981; border: 1px solid #10b981;' : (badAlign ? 'background: rgba(239, 68, 68, 0.08); color: #ef4444; border: 1px solid #ef4444;' : 'background: rgba(100, 116, 139, 0.08); color: var(--text-muted); border: 1px solid var(--text-muted);');
            
            const level = stats.price_level || '-';
            let levelStyle = '';
            if (level === '머리') { levelStyle = 'color: #ef4444; background: rgba(239, 68, 68, 0.08); border: 1px solid #ef4444;'; }
            else if (level === '어깨') { levelStyle = 'color: #d97706; background: rgba(245, 158, 11, 0.08); border: 1px solid #d97706;'; }
            else if (level === '무릎') { levelStyle = 'color: #10b981; background: rgba(16, 185, 129, 0.08); border: 1px solid #10b981;'; }
            else { levelStyle = 'color: var(--text-muted); background: rgba(100, 116, 139, 0.08); border: 1px solid var(--text-muted);'; }
            
            const pos = stats.price_position_ratio !== undefined ? `${stats.price_position_ratio}%` : '';
            let high26w = stats.twenty_six_week_high ? stats.twenty_six_week_high.toLocaleString() : '-';
            let sPrice = stats.support_price ? stats.support_price.toLocaleString() : '-';
            let rPrice = stats.resistance_price ? stats.resistance_price.toLocaleString() : '-';
            
            let supportVisible = 'none', resistanceVisible = 'none';
            
            let pLow = stats.four_month_low;
            let pSupp = stats.support_price;
            let pRes = stats.resistance_price;
            let pHigh = stats.twenty_six_week_high;
            let pCurr = stock.price;
            
            // 모든 기준선을 균등하게 배치하여 UI 쏠림 완전 방지 (Dynamic Piecewise Mapping)
            let nodes = [];
            nodes.push({ val: pLow || 0, type: 'low', pos: 0 });
            if (pSupp) nodes.push({ val: pSupp, type: 'supp', pos: 0 });
            if (pRes) nodes.push({ val: pRes, type: 'res', pos: 0 });
            nodes.push({ val: pHigh || (pLow > 0 ? pLow + 1 : 100), type: 'high', pos: 0 });
            
            // 값을 기준으로 오름차순 정렬하여 순서 꼬임 및 동일 값(0 나누기) 방지
            nodes.sort((a, b) => a.val - b.val);
            
            // 정렬된 순서대로 0% ~ 100% 사이에 균등한 간격(UI 위치) 부여
            for (let i = 0; i < nodes.length; i++) {
                nodes[i].pos = (i / (nodes.length - 1)) * 100;
            }
            
            let trackLow = 0, trackSupp = 33.3, trackRes = 66.6, trackHigh = 100, trackCurr = 50;
            
            for (let node of nodes) {
                if (node.type === 'low') trackLow = node.pos;
                if (node.type === 'supp') { trackSupp = node.pos; supportVisible = 'block'; }
                if (node.type === 'res') { trackRes = node.pos; resistanceVisible = 'block'; }
                if (node.type === 'high') trackHigh = node.pos;
            }
            
            // 현재가를 부여된 구간들 사이에서 동적 비율로 계산
            if (pCurr <= nodes[0].val) {
                trackCurr = 0;
            } else if (pCurr >= nodes[nodes.length - 1].val) {
                trackCurr = 100;
            } else {
                for (let i = 0; i < nodes.length - 1; i++) {
                    let n1 = nodes[i];
                    let n2 = nodes[i+1];
                    if (pCurr >= n1.val && pCurr <= n2.val) {
                        let range = n2.val - n1.val;
                        if (range === 0) {
                            trackCurr = n1.pos;
                        } else {
                            let ratio = (pCurr - n1.val) / range;
                            trackCurr = n1.pos + ratio * (n2.pos - n1.pos);
                        }
                        break;
                    }
                }
            }
            
            let supportRatio = trackSupp;
            let resistanceRatio = trackRes;
            let gaugeRatio = trackCurr;
            
            let dropVal = stock.drop || (stats.four_month_high && stock.price ? ((stock.price - stats.four_month_high) / stats.four_month_high) * 100 : 0);

            const getLabelStyle = (ratio) => {
                if (ratio < 15) return 'left: 0; transform: translateX(-10%); text-align: left;';
                if (ratio > 85) return 'right: 0; left: auto; transform: translateX(10%); text-align: right;';
                return 'left: 50%; transform: translateX(-50%); text-align: center;';
            };

            let cardHtml = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.2rem;">
                    <div style="display: flex; gap: 0.3rem;">
                        <span style="font-size: 0.65rem; font-weight: 700; padding: 0.15rem 0.4rem; border-radius: 4px; ${levelStyle}">${level} ${pos}</span>
                        <span style="font-size: 0.65rem; font-weight: 700; padding: 0.15rem 0.4rem; border-radius: 4px; ${maStyle}">${align}</span>
                    </div>
                    <div style="font-size: 0.7rem; font-weight: 700; color: ${stock.drop < -8.0 ? 'var(--accent-orange)' : (stock.drop < -4.4 ? 'var(--accent-green)' : 'var(--text-muted)')}; background: ${stock.drop < -8.0 ? 'rgba(249, 115, 22, 0.05)' : (stock.drop < -4.4 ? 'rgba(16, 185, 129, 0.05)' : 'transparent')}; padding: 0.15rem 0.4rem; border-radius: 4px;">
                        당일 낙폭: ${stock.drop_str}
                    </div>
                </div>
                
                
                <div style="margin-top: 3.5rem; padding: 0 0.5rem; margin-bottom: 2rem;">
                    <div class="gauge-track" style="position: relative; height: 12px; background: #e2e8f0; border-radius: 6px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.1);">
                        <!-- Price Zones (가격구간) -->
                        <div style="position: absolute; left: 0%; width: ${supportRatio}%; height: 100%; background: rgba(16, 185, 129, 0.35); border-radius: 6px 0 0 6px;" title="매수 가능 구간 (발바닥~무릎)"></div>
                        <div style="position: absolute; left: ${supportRatio}%; width: ${resistanceRatio - supportRatio}%; height: 100%; background: rgba(245, 158, 11, 0.35);" title="보유/관망 구간 (무릎~어깨)"></div>
                        <div style="position: absolute; left: ${resistanceRatio}%; width: ${100 - resistanceRatio}%; height: 100%; background: rgba(239, 68, 68, 0.35); border-radius: 0 6px 6px 0;" title="매도 고려 구간 (어깨~머리)"></div>
                        <!-- Low (최저가) at bottom -->
                        <div style="position: absolute; top: -5px; left: 0%; width: 4px; height: 20px; background: #cbd5e1; transform: translateX(-50%); border-radius: 2px;">
                            <div style="position: absolute; top: 24px; left: 0; transform: translateX(0); font-size: 0.65rem; color: var(--text-muted); white-space: nowrap; text-align: left; line-height: 1.2;">
                                최저 (발바닥)<br><span style="font-weight:600;">${stats.four_month_low ? stats.four_month_low.toLocaleString() : '-'}</span>
                            </div>
                        </div>

                        <!-- Support (지지선) at top -->
                        <div style="position: absolute; top: -9px; left: ${supportRatio}%; width: 6px; height: 28px; background: #10b981; display: ${supportVisible}; z-index: 1; transform: translateX(-50%); border-radius: 3px;">
                            <div style="position: absolute; top: -36px; ${getLabelStyle(supportRatio)} font-size: 0.65rem; color: #10b981; white-space: nowrap; font-weight: 800; line-height: 1.2;">
                                지지가 (무릎)<br>${sPrice}
                            </div>
                        </div>

                        <!-- Resistance (저항선) at bottom -->
                        <div style="position: absolute; top: -9px; left: ${resistanceRatio}%; width: 6px; height: 28px; background: #ef4444; display: ${resistanceVisible}; z-index: 1; transform: translateX(-50%); border-radius: 3px;">
                            <div style="position: absolute; top: 24px; ${getLabelStyle(resistanceRatio)} font-size: 0.65rem; color: #ef4444; white-space: nowrap; font-weight: 800; line-height: 1.2;">
                                저항가 (어깨)<br>${rPrice}
                            </div>
                        </div>

                        <!-- High (최고가) at top -->
                        <div style="position: absolute; top: -5px; left: 100%; width: 4px; height: 20px; background: #cbd5e1; transform: translateX(-50%); border-radius: 2px;">
                            <div style="position: absolute; top: -36px; right: 0; left: auto; transform: translateX(0); font-size: 0.65rem; color: var(--text-muted); white-space: nowrap; text-align: right; line-height: 1.2;">
                                26주 최고가 (머리)<br><span style="font-weight:600;">${high26w}</span>
                                ${(stats.twenty_six_week_high && stock.price >= stats.twenty_six_week_high) ? `<br><span style="font-size: 0.55rem; background: #fee2e2; color: #ef4444; border: 1px solid #fca5a5; padding: 0.05rem 0.25rem; border-radius: 4px; display: inline-block; margin-top: 0.15rem; font-weight: 800;">🔥 신고가 돌파</span>` : ''}
                            </div>
                        </div>

                        <!-- Current (현재가) at very top -->
                        <div style="position: absolute; top: -13px; left: ${gaugeRatio}%; width: 6px; height: 36px; background: #0f172a; border-radius: 3px; z-index: 3; box-shadow: 0 0 5px rgba(0,0,0,0.4); transform: translateX(-50%);">
                            <div style="position: absolute; top: -62px; ${getLabelStyle(gaugeRatio)} font-size: 0.8rem; color: #ffffff; background: #0f172a; padding: 4px 8px; border-radius: 6px; white-space: nowrap; text-align: center; font-weight: 800; line-height: 1.2; box-shadow: 0 3px 6px rgba(0,0,0,0.3);">
                                현재가 ${stock.price_str}
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            cardContent.innerHTML = cardHtml;
            cardContent.style.display = 'flex';
        });
        };
        
        if (stock4mCache.has(stock.code)) {
            fetchAndRender();
        } else {
            setTimeout(fetchAndRender, delayCounter * 200);
            delayCounter++;
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
                
                const currentThemeRate = typeof theme.avg_rate !== 'undefined' ? parseFloat(theme.avg_rate) : 0;
                
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
                        theme_rate: currentThemeRate,
                        role: stock.role,
                        buy_zone_1: stock.buy_zone_1,
                        buy_zone_2: stock.buy_zone_2,
                        ma10_above_ma20: stock.ma10_above_ma20,
                        description: stock.description,
                        four_month_high_str: stock.four_month_high_str,
                        themes: [theme.theme_name],
                        leaderOfThemes: isLeader ? [theme.theme_name] : []
                    });
                } else {
                    const existing = stockMap.get(code);
                    if (currentThemeRate > existing.theme_rate) {
                        existing.theme_rate = currentThemeRate;
                    }
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

    let consolidatedList = Array.from(stockMap.values());

    // Filter by my holdings if checkbox is checked
    const filterHoldingsOnly = document.getElementById('filter-holdings-only')?.checked;
    if (filterHoldingsOnly) {
        consolidatedList = consolidatedList.filter(stock => myHoldingSymbols.has(stock.code));
    }

    if (consolidatedList.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        if (filterHoldingsOnly) {
            emptyMsg.innerHTML = '<div style="padding: 2rem; color: var(--text-muted); text-align: center;">보유 중인 대장주가 없습니다.</div>';
        }
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
            // ALT-01 조건: 거래대금 1500억 이상 & 테마 평균 등락률 양수 & 낙폭 -4.0 ~ -8.0
            const isAlt01 = stock.volume >= 150000000000 && stock.theme_rate > 0 && stock.drop >= -8.0 && stock.drop <= -4.0;
            
            if (isAlt01) {
                alertBadge = '<span style="background: #fff1f2; color: #e11d48; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 800; border: 1px solid #fda4af; display: inline-flex; align-items: center; gap: 0.15rem; box-shadow: 0 0 8px rgba(225, 29, 72, 0.2);">🚀 ALT-01 포착</span>';
            } else if (stock.drop >= -8.0 && stock.drop <= -4.0) {
                alertBadge = '<span style="background: #ecfdf5; color: #10b981; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 700; border: 1px solid #a7f3d0; display: inline-flex; align-items: center; gap: 0.15rem;">🟢 타점진입</span>';
            } else if (stock.drop < -8.0) {
                alertBadge = '<span style="background: #fffbeb; color: #d97706; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 700; border: 1px solid #fde68a; display: inline-flex; align-items: center; gap: 0.15rem;">🟡 과락구간</span>';
            } else {
                alertBadge = '<span style="background: #fef2f2; color: #ef4444; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.65rem; font-weight: 700; border: 1px solid #fca5a5; display: inline-flex; align-items: center; gap: 0.15rem;">🔴 관망구간</span>';
            }
        }

        const themeRateVal = stock.theme_rate || 0;
        const themeRateClass = themeRateVal > 0 ? 'up' : (themeRateVal < 0 ? 'down' : 'flat');
        const themeRateStr = (themeRateVal > 0 ? '+' : '') + themeRateVal.toFixed(2) + '%';

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
            <td class="${themeRateClass}" style="padding: 0.6rem 0.5rem; text-align: right; font-weight: 800; font-family: var(--font-outfit); font-size: 0.85rem;">
                ${themeRateStr}
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
                    <button onclick="showStockNetworkMap('${stock.name}', '${stock.code}')" style="display: inline-flex; align-items: center; justify-content: center; min-width: 54px; box-sizing: border-box; padding: 0.25rem 0.5rem; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 4px; font-size: 0.65rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease;" onmouseover="this.style.background='#dbeafe'; this.style.borderColor='#93c5fd';" onmouseout="this.style.background='#eff6ff'; this.style.borderColor='#bfdbfe';" title="실시간 주가 차트 보기">차트</button>
                    <a href="https://www.tossinvest.com/stocks/A${stock.code}/order" target="_blank" style="display: inline-flex; align-items: center; justify-content: center; min-width: 54px; box-sizing: border-box; padding: 0.25rem 0.5rem; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 4px; font-size: 0.65rem; font-weight: 600; text-decoration: none; transition: all 0.2s ease;" onmouseover="this.style.background='#bae6fd'; this.style.color='#0369a1';" onmouseout="this.style.background='#e0f2fe'; this.style.color='#0369a1';" title="토스증권에서 주문">토스</a>
                    <button onclick="openNewsModal('${stock.code}', '${stock.name}')" style="display: inline-flex; align-items: center; justify-content: center; min-width: 54px; box-sizing: border-box; gap: 0.2rem; padding: 0.25rem 0.5rem; background: #fff7ed; color: #ea580c; border: 1px solid #fdba74; border-radius: 4px; font-size: 0.65rem; font-weight: 700; cursor: pointer; transition: all 0.2s ease;" onmouseover="this.style.background='#ffedd5'; this.style.borderColor='#fb923c';" onmouseout="this.style.background='#fff7ed'; this.style.borderColor='#fdba74';" title="네이버 증권 뉴스 및 공시 보기"><span style="font-size: 0.7rem;">📰</span> 뉴스</button>
                </div>
            </td>
        `;

        // Tooltip displaying buy target bands on hover of the row
        let rowTooltip = `${stock.name} | ${stock.description || ''}`;
        if (isStockLeader) {
            rowTooltip += `\n★ 대장 테마: ${leaderThemesStr}`;
        }
        rowTooltip += `\n4M 최고가: ${stock.four_month_high_str || '-'}\n1차 타점: ${stock.buy_zone_1 || '-'}\n2차 타점: ${stock.buy_zone_2 || '-'}`;
        tr.title = rowTooltip;

        tbody.appendChild(tr);
    });
    
    renderTechPanel(consolidatedList);
}

// ==========================================
// ==========================================
let activeMainView = 'grid'; // 'grid', 'stock', 'sangtta'
let chartInstances = {}; // To store Chart.js instances

function switchMainView(viewType) {
    activeMainView = viewType;
    const tabGrid = document.getElementById('tab-grid-view');
    const tabStock = document.getElementById('tab-stock-view');
    const tabSangtta = document.getElementById('tab-sangtta-view');
    const gridContainer = document.getElementById('grid-view-container');
    const stockContainer = document.getElementById('stock-view-wrapper');
    const sangttaContainer = document.getElementById('sangtta-view-container');

    // Reset styles
    [tabGrid, tabStock, tabSangtta].forEach(tab => {
        if (tab) {
            tab.classList.remove('active');
            tab.style.color = 'var(--text-muted)';
        }
    });
    [gridContainer, stockContainer, sangttaContainer].forEach(c => {
        if (c) c.style.display = 'none';
    });

    if (viewType === 'grid') {
        if (tabGrid) {
            tabGrid.classList.add('active');
            tabGrid.style.color = 'var(--accent-blue)';
        }
        if (gridContainer) gridContainer.style.display = 'flex';
        
        if (currentGridViewMode === 'detail') renderDashboard();
        else renderHeatmap();
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
            <div style="display: flex; gap: 0.4rem; justify-content: center; align-items: center;">
                <button onclick="showStockNetworkMap('${stock.name}', '${stock.code}')" style="display: inline-flex; align-items: center; justify-content: center; min-width: 80px; box-sizing: border-box; padding: 0.35rem 0.65rem; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 6px; font-size: 0.72rem; font-weight: 700; cursor: pointer; transition: all 0.2s ease;" onmouseover="this.style.background='#dbeafe'; this.style.borderColor='#93c5fd';" onmouseout="this.style.background='#eff6ff'; this.style.borderColor='#bfdbfe';" title="실시간 주가 차트 보기">차트</button>
                <a href="${stock.toss_url}" target="_blank" style="display: inline-flex; align-items: center; justify-content: center; min-width: 80px; box-sizing: border-box; padding: 0.35rem 0.65rem; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 6px; font-size: 0.72rem; font-weight: 700; text-decoration: none; transition: all 0.2s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.05);" onmouseover="this.style.background='#bae6fd'; this.style.color='#0369a1';" onmouseout="this.style.background='#e0f2fe'; this.style.color='#0369a1';" title="토스증권에서 주문">🚀 토스 주문</a>
                <button onclick="openNewsModal('${stock.code}', '${stock.name}')" style="display: inline-flex; align-items: center; justify-content: center; min-width: 80px; box-sizing: border-box; gap: 0.2rem; padding: 0.35rem 0.65rem; background: #fff7ed; color: #ea580c; border: 1px solid #fdba74; border-radius: 6px; font-size: 0.72rem; font-weight: 700; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 1px 2px rgba(234, 88, 12, 0.05);" onmouseover="this.style.background='#ffedd5'; this.style.borderColor='#fb923c';" onmouseout="this.style.background='#fff7ed'; this.style.borderColor='#fdba74';" title="네이버 증권 뉴스 및 공시 보기"><span style="font-size: 0.75rem;">📰</span> 뉴스</button>
            </div>
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
    // Note: Network view removed. Redirecting to grid view instead.
    switchMainView('grid');
}

function renderLeaderCharts() {
    // Network view removed.
}

async function fetchAndDrawChart(stockCode) {
    const spinner = document.getElementById(`spinner-${stockCode}`);
    const canvas = document.getElementById(`canvas-${stockCode}`);
    if (!canvas) return;

    try {
        const [chartRes, stats] = await Promise.all([
            fetch(`/api/v1/market/stocks/${stockCode}/chart`),
            loadStock4mStats(stockCode)
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
            const band = compute4mBand(stats);
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

const stock4mCache = new Map();
const stock4mPromises = new Map();

function loadStock4mStats(stockCode) {
    if (stock4mCache.has(stockCode)) return Promise.resolve(stock4mCache.get(stockCode));
    if (stock4mPromises.has(stockCode)) return stock4mPromises.get(stockCode);
    
    const p = fetch(`/api/v1/market/stocks/${stockCode}/stats-4m`)
        .then(response => response.json())
        .then(result => {
            if (result.status === 'success') {
                stock4mCache.set(stockCode, result);
                stock4mPromises.delete(stockCode);
                return result;
            } else {
                stock4mPromises.delete(stockCode);
                return null;
            }
        })
        .catch(e => {
            console.error(`Error loading 4-month stats for ${stockCode}:`, e);
            stock4mPromises.delete(stockCode);
            return null;
        });
        
    stock4mPromises.set(stockCode, p);
    return p;
}

// 4개월 고가/저가로 머리·어깨 구간 경계(70%/35%)를 계산합니다. 데이터가 없으면 null.
function compute4mBand(stats) {
    if (!stats || !(stats.four_month_high > 0) || !(stats.four_month_low > 0)) return null;
    const high = stats.four_month_high;
    const low = stats.four_month_low;
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
        { ...base, label: '4M 구간', data: fillArr.map(() => band.low), backgroundColor: 'rgba(148, 163, 184, 0.07)', fill: { target: 1 } },
        { ...base, label: '4M 상한', data: fillArr.map(() => band.high) },
        { ...base, label: '머리 하한', data: fillArr.map(() => band.headLow), borderColor: 'rgba(239, 68, 68, 0.65)', borderWidth: 1, borderDash: [4, 4] },
        { ...base, label: '어깨 하한', data: fillArr.map(() => band.shoulderLow), borderColor: 'rgba(217, 119, 6, 0.65)', borderWidth: 1, borderDash: [4, 4] },
    ];
}

async function fetchAndRenderPriceBands(stockCode) {
    const result = await loadStock4mStats(stockCode);
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
        levelBadge.title = `최근 4개월 수급 위치 (야후 파이낸스): ${result.price_position_ratio}% (${result.price_level_desc || ''})`;
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
        const stats = await loadStock4mStats(stockCode);
        
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
                const align = stats.ma_alignment || '-';
                maEl.innerText = align;
                const good = align.includes('정배열');
                const bad = align.includes('역배열');
                maEl.style.color = good ? '#10b981' : (bad ? '#ef4444' : 'var(--text-muted)');
                maEl.style.background = good ? 'rgba(16, 185, 129, 0.08)' : (bad ? 'rgba(239, 68, 68, 0.08)' : 'rgba(100, 116, 139, 0.08)');
                maEl.style.border = `1px solid ${good ? '#10b981' : (bad ? '#ef4444' : 'var(--text-muted)')}`;
            }

            const high26wEl = document.getElementById('hover-26w-high');
            if (high26wEl) {
                high26wEl.innerText = stats.twenty_six_week_high ? stats.twenty_six_week_high.toLocaleString() : '-';
            }
            
            const supportEl = document.getElementById('hover-support');
            if (supportEl) {
                supportEl.innerText = stats.support_price ? `지지: ${stats.support_price.toLocaleString()}` : '지지: -';
            }

            const resistanceEl = document.getElementById('hover-resistance');
            if (resistanceEl) {
                resistanceEl.innerText = stats.resistance_price ? `저항: ${stats.resistance_price.toLocaleString()}` : '저항: -';
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
                    
                    const supportLine = document.getElementById('hover-gauge-support-line');
                    const resistanceLine = document.getElementById('hover-gauge-resistance-line');
                    
                    if (stats.four_month_low && stats.twenty_six_week_high && stats.twenty_six_week_high > stats.four_month_low) {
                        const low = stats.four_month_low;
                        const high = stats.twenty_six_week_high;
                        const pRange = high - low;
                        
                        if (supportLine && stats.support_price) {
                            let srRatio = ((stats.support_price - low) / pRange) * 100;
                            srRatio = Math.max(0, Math.min(100, srRatio));
                            supportLine.style.display = 'block';
                            supportLine.style.left = `${srRatio}%`;
                            const sPriceEl = document.getElementById('hover-gauge-support-price');
                            if (sPriceEl) sPriceEl.innerText = stats.support_price.toLocaleString();
                        } else if (supportLine) {
                            supportLine.style.display = 'none';
                        }
                        
                        if (resistanceLine && stats.resistance_price) {
                            let rrRatio = ((stats.resistance_price - low) / pRange) * 100;
                            rrRatio = Math.max(0, Math.min(100, rrRatio));
                            resistanceLine.style.display = 'block';
                            resistanceLine.style.left = `${rrRatio}%`;
                            const rPriceEl = document.getElementById('hover-gauge-resistance-price');
                            if (rPriceEl) rPriceEl.innerText = stats.resistance_price.toLocaleString();
                        } else if (resistanceLine) {
                            resistanceLine.style.display = 'none';
                        }
                    } else {
                        if (supportLine) supportLine.style.display = 'none';
                        if (resistanceLine) resistanceLine.style.display = 'none';
                    }
                }, 10);
            } else if (gaugeContainer) {
                gaugeContainer.style.display = 'none';
            }
            
            const band = compute4mBand(stats);
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
    let seenStocks = new Set();
    
    topThemes.forEach((theme, themeIndex) => {
        if (!theme.top_stocks) return;
        const themeScore = 8 - themeIndex;
        const themeVolumeNum = parseFloat(theme.total_volume_str.replace(/[^0-9.]/g, '')) || 1;
        
        // Pick top 2 stocks from the theme
        const topStocks = theme.top_stocks.slice(0, 2);
        topStocks.forEach((stock) => {
            if (seenStocks.has(stock.stock_code)) return;
            seenStocks.add(stock.stock_code);
            
            const rate = parseFloat(stock.rate) || 0;
            const drop = parseFloat(stock.drop) || 0;
            const volStr = stock.volume_str || '0';
            const vol = parseFloat(volStr.replace(/[^0-9.]/g, '')) || 0;
            
            let dominance = 0;
            if (themeVolumeNum > 0 && vol > 0) {
                dominance = Math.min(100, (vol / themeVolumeNum) * 100);
            }
            
            // Algorithm: Rate 7% ~ 25%, Drop 0 to -8%, Volume >= 1500억
            if (rate >= 7.0 && rate <= 25.0 && drop >= -8.0 && vol >= 1500) {
                let score = rate + (dominance * 0.1) + themeScore;
                if (drop >= -5.0) score += 3; // Bonus for strong holding power
                if (vol >= 3000) score += 2; // Bonus for decent liquidity (>3000억)
                
                let reason = `주도 테마(${themeIndex + 1}위) 내 핵심주로 `;
                if (drop >= -3.0) {
                    reason += `고점 대비 낙폭(${drop.toFixed(2)}%)이 적어 매수세가 강력합니다.`;
                } else if (drop >= -6.0) {
                    reason += `안정적 낙폭(${drop.toFixed(2)}%)으로 종가 눌림목 공략이 유효합니다.`;
                } else {
                    reason += `지지선을 방어하며(${drop.toFixed(2)}%) 재반등 추세를 보입니다.`;
                }
                
                if (dominance > 60) {
                    reason += ` (테마 수급 독식 👑)`;
                }
                
                candidates.push({ stock, themeName: theme.theme_name, score, reason });
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
        
        // Extract all themes for this stock from themesData
        const allThemes = themesData
            .filter(t => t.top_stocks && t.top_stocks.some(ts => ts.stock_code === s.stock_code))
            .map(t => t.theme_name);
            
        const otherThemes = allThemes.filter(name => name !== c.themeName);
        
        let allTagElements = [];
        allTagElements.push(`<span style="font-size: 0.7rem; font-weight: 700; color: var(--accent-blue); background: rgba(29, 78, 216, 0.1); padding: 0.2rem 0.4rem; border-radius: 4px; white-space: nowrap; cursor: pointer;" onclick="event.stopPropagation(); scrollToTheme('${c.themeName}')">👑 ${c.themeName} 대장</span>`);
        
        otherThemes.forEach((name, i) => {
            const colors = ['#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6'];
            const cHex = colors[i % colors.length];
            allTagElements.push(`<span style="font-size: 0.65rem; font-weight: 600; color: ${cHex}; background: ${cHex}15; border: 1px solid ${cHex}30; padding: 0.15rem 0.35rem; border-radius: 4px; white-space: nowrap; cursor: pointer;" onclick="event.stopPropagation(); scrollToTheme('${name}')">${name}</span>`);
        });
        
        let themeTagsCompactHtml = `<div style="display: flex; gap: 0.2rem; overflow: hidden; white-space: nowrap;">${allTagElements.slice(0, 3).join('')}</div>`;
        
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
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.1rem;">
                <div style="display: flex; align-items: baseline; gap: 0.3rem;">
                    <span style="font-size: 0.95rem; font-weight: 800; color: var(--text-primary);">${s.stock_name}</span>
                    <span style="font-size: 0.75rem; font-weight: 800;" class="${rateClass}">${rateSign}${s.rate}%</span>
                </div>
                <div style="display: flex; gap: 0.2rem;">
                    <span style="font-size: 0.6rem; font-weight: 800; color: #ef4444; background: rgba(239, 68, 68, 0.1); padding: 0.1rem 0.25rem; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.2);">AI PICK</span>
                    <span style="font-size: 0.6rem; font-weight: 700; color: var(--text-muted); background: rgba(0,0,0,0.03); padding: 0.1rem 0.25rem; border-radius: 4px;">${s.volume_str || '-'}</span>
                </div>
            </div>
            
            <div style="display: flex; gap: 0.3rem; margin-bottom: 0.1rem;">
                <div style="flex: 1; font-size: 0.65rem; color: var(--text-secondary); background: rgba(248, 250, 252, 0.6); padding: 0.15rem 0.3rem; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(0,0,0,0.02);">
                    <span style="font-weight: 600;">당일낙폭</span>
                    <span style="font-weight: 800; color: ${parseFloat(s.drop) < -5 ? 'var(--accent-orange)' : 'var(--accent-green)'};">${parseFloat(s.drop || 0).toFixed(2)}%</span>
                </div>
                <div style="flex: 1; font-size: 0.65rem; color: var(--text-secondary); background: rgba(248, 250, 252, 0.6); padding: 0.15rem 0.3rem; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(0,0,0,0.02);">
                    <span style="font-weight: 600;">1차타점</span>
                    <span style="font-weight: 800; color: var(--text-primary);">${s.buy_zone_1 || '-'}</span>
                </div>
            </div>

            <div style="font-size: 0.6rem; display: flex; flex-direction: column; gap: 0.2rem;">
                ${themeTagsCompactHtml}
                <div style="background: rgba(239, 68, 68, 0.04); border-left: 2px solid rgba(239, 68, 68, 0.4); padding: 0.15rem 0.3rem; border-radius: 0 4px 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.6rem; color: var(--text-secondary);">
                    <span style="font-weight: 700; color: #ef4444;">추천사유:</span> <span style="font-weight: 600;">${c.reason}</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function scrollToTheme(themeName) {
    // Hide hover tooltip since the mouseleave event might not trigger when view switches
    handleStockLeave();

    // Switch to grid view so the themes are visible
    switchMainView('grid');

    // Slight delay to allow DOM to render display change
    setTimeout(() => {
        const titles = document.querySelectorAll('.theme-card-title');
        for (const title of titles) {
            if (title.innerText.trim() === themeName.trim()) {
                const card = title.closest('.theme-card');
                if (card) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    card.style.transition = 'box-shadow 0.3s ease';
                    card.style.boxShadow = '0 0 15px 3px var(--accent-orange)';
                    setTimeout(() => {
                        card.style.boxShadow = '';
                    }, 5000);
                }
                break;
            }
        }
    }, 50);
}
// ==========================================
// Stock Market Heatmap 
// ==========================================
let heatmapMode = 'treemap'; // 'treemap' or 'grid'
let currentGridViewMode = 'detail'; // 'detail' or 'heatmap'

function toggleGridMode() {
    currentGridViewMode = currentGridViewMode === 'detail' ? 'heatmap' : 'detail';
    
    const btn = document.getElementById('btn-toggle-grid-mode');
    const detailGrid = document.getElementById('dashboard-grid-container');
    const heatmapSub = document.getElementById('heatmap-subview-container');
    
    if (currentGridViewMode === 'heatmap') {
        btn.innerHTML = '📋 상세 리스트 뷰';
        btn.style.background = '#0f172a';
        detailGrid.style.display = 'none';
        heatmapSub.style.display = 'flex';
        renderHeatmap();
    } else {
        btn.innerHTML = '🗺️ 히트맵 뷰';
        btn.style.background = 'var(--accent-blue)';
        detailGrid.style.display = 'grid';
        heatmapSub.style.display = 'none';
        renderDashboard();
    }
}

function switchHeatmapMode(mode) {
    heatmapMode = mode;
    
    // Update button UI
    const btnTreemap = document.getElementById('heatmap-btn-treemap');
    const btnGrid = document.getElementById('heatmap-btn-grid');
    
    if (mode === 'treemap') {
        btnTreemap.style.background = 'white';
        btnTreemap.style.color = 'var(--text-primary)';
        btnTreemap.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
        btnGrid.style.background = 'transparent';
        btnGrid.style.color = 'var(--text-muted)';
        btnGrid.style.boxShadow = 'none';
    } else {
        btnGrid.style.background = 'white';
        btnGrid.style.color = 'var(--text-primary)';
        btnGrid.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
        btnTreemap.style.background = 'transparent';
        btnTreemap.style.color = 'var(--text-muted)';
        btnTreemap.style.boxShadow = 'none';
    }
    
    renderHeatmap();
}

function getHeatmapColor(rate) {
    const val = parseFloat(rate) || 0;
    if (val >= 15) return '#b91c1c'; // Strong Red
    if (val >= 7) return '#dc2626';  // Red
    if (val > 2) return '#ef4444';   // Light Red
    if (val > 0) return '#fca5a5';   // Very Light Red
    if (val === 0) return '#64748b'; // Gray
    if (val >= -2) return '#93c5fd'; // Very Light Blue
    if (val >= -7) return '#3b82f6'; // Blue
    if (val >= -15) return '#2563eb';// Strong Blue
    return '#1d4ed8'; // Dark Blue
}

function renderHeatmap() {
    const canvas = document.getElementById('heatmap-canvas');
    if (!canvas) return;
    
    // 1. Get processed themes
    let processedThemes = getProcessedThemes();
    
    // 2. Identify 'Hot Theme Group'
    const leaderGroups = {};
    processedThemes.forEach(theme => {
        const leader = theme.leader_stock;
        const groupKey = leader ? leader : theme.theme_name;
        if (!leaderGroups[groupKey]) leaderGroups[groupKey] = { themes: [], raw_volume: 0 };
        leaderGroups[groupKey].themes.push(theme);
        leaderGroups[groupKey].raw_volume += theme.total_volume || 0;
    });

    // Sort groups by raw_volume descending to give priority to bigger groups when deduplicating stocks
    const sortedGroups = Object.values(leaderGroups).sort((a, b) => b.raw_volume - a.raw_volume);
    
    let hThemes = [];
    const globalStockSet = new Set();

    sortedGroups.forEach(group => {
        const stockMap = new Map();
        group.themes.forEach(t => {
            (t.top_stocks || []).forEach(s => {
                // Global deduplication to prevent a stock from appearing twice in the heatmap
                if (!globalStockSet.has(s.stock_code)) {
                    stockMap.set(s.stock_code, s);
                    globalStockSet.add(s.stock_code);
                }
            });
        });
        const mergedStocks = Array.from(stockMap.values());
        
        if (mergedStocks.length > 0) {
            // Sum volumes of the unique merged top stocks
            const mergedVol = mergedStocks.reduce((sum, s) => sum + (s.volume || 0), 0);
            const avgRate = mergedStocks.length > 0 ? mergedStocks.reduce((sum, s) => sum + (s.rate || 0), 0) / mergedStocks.length : 0;
            const combinedThemeName = group.themes.length > 1 ? `👑 ${group.themes[0].leader_stock} 주도 그룹` : group.themes[0].theme_name;

            hThemes.push({
                theme_name: combinedThemeName,
                total_volume: mergedVol,
                avg_rate: avgRate,
                leader_stock: group.themes[0].leader_stock,
                top_stocks: mergedStocks
            });
        }
    });
    
    // 3. Sort by total volume and get top 40
    hThemes = hThemes.sort((a, b) => b.total_volume - a.total_volume).slice(0, 40);
    
    if (hThemes.length === 0) {
        canvas.innerHTML = '<div style="display:flex; justify-content:center; align-items:center; height:100%; color:var(--text-muted);">조건에 맞는 핫 테마군 데이터가 없습니다.</div>';
        return;
    }

    canvas.innerHTML = '';
    
        if (heatmapMode === 'treemap') {
        canvas.style.display = 'block';
        canvas.style.position = 'relative';
        canvas.style.padding = '0';
        canvas.style.flex = '1';
        canvas.style.overflow = 'hidden';
        
        // Wait for canvas to have dimensions
        const cw = canvas.clientWidth || 1000;
        const ch = canvas.clientHeight || 800;
        
        let themeNodes = hThemes.map(t => ({
            data: t,
            value: Math.max(t.total_volume || 1, 1)
        }));
        
        computeTreemap(themeNodes, 0, 0, cw, ch);
        
        themeNodes.forEach(tNode => {
            const tb = tNode.bounds;
            if (!tb || tb.w <= 0 || tb.h <= 0) return;
            
            const themeBlock = document.createElement('div');
            themeBlock.style.position = 'absolute';
            themeBlock.style.left = tb.x + 'px';
            themeBlock.style.top = tb.y + 'px';
            themeBlock.style.width = tb.w + 'px';
            themeBlock.style.height = tb.h + 'px';
            themeBlock.style.border = '1px solid #0f172a';
            themeBlock.style.boxSizing = 'border-box';
            themeBlock.style.overflow = 'hidden';
            themeBlock.style.backgroundColor = '#0f172a';
            
            const headerH = 22;
            const header = document.createElement('div');
            header.style.position = 'absolute';
            header.style.top = '0';
            header.style.left = '0';
            header.style.width = '100%';
            header.style.height = headerH + 'px';
            header.style.background = 'rgba(0,0,0,0.85)';
            header.style.color = '#f1f5f9';
            header.style.fontSize = '0.75rem';
            header.style.fontWeight = '700';
            header.style.textAlign = 'center';
            header.style.lineHeight = headerH + 'px';
            header.style.cursor = 'pointer';
            header.style.zIndex = '10';
            header.style.whiteSpace = 'nowrap';
            header.style.overflow = 'hidden';
            header.style.textOverflow = 'ellipsis';
            header.innerText = tNode.data.theme_name;
            
            header.onclick = () => {
                if (currentGridViewMode === 'heatmap') toggleGridMode();
                triggerSearch(tNode.data.theme_name);
            };
            themeBlock.appendChild(header);
            
            if (tb.h > headerH) {
                let stocks = tNode.data.top_stocks || [];
                let stockNodes = stocks.map(s => ({
                    data: s,
                    value: Math.max(s.volume || 1, 1)
                }));
                
                computeTreemap(stockNodes, 0, headerH, tb.w, tb.h - headerH);
                
                stockNodes.forEach(sNode => {
                    const sb = sNode.bounds;
                    if (!sb || sb.w <= 0 || sb.h <= 0) return;
                    
                    const stockBlock = document.createElement('div');
                    stockBlock.style.position = 'absolute';
                    stockBlock.style.left = sb.x + 'px';
                    stockBlock.style.top = sb.y + 'px';
                    stockBlock.style.width = sb.w + 'px';
                    stockBlock.style.height = sb.h + 'px';
                    stockBlock.style.backgroundColor = getHeatmapColor(sNode.data.rate);
                    stockBlock.style.border = '1px solid rgba(255,255,255,0.15)';
                    stockBlock.style.boxSizing = 'border-box';
                    stockBlock.style.cursor = 'pointer';
                    stockBlock.style.display = 'flex';
                    stockBlock.style.flexDirection = 'column';
                    stockBlock.style.justifyContent = 'center';
                    stockBlock.style.alignItems = 'center';
                    stockBlock.style.overflow = 'hidden';
                    stockBlock.style.transition = 'filter 0.1s';
                    
                    stockBlock.onmouseenter = (e) => {
                        stockBlock.style.filter = 'brightness(1.2)';
                        handleStockHover(e, sNode.data.stock_code, sNode.data.stock_name);
                    };
                    stockBlock.onmouseleave = (e) => {
                        stockBlock.style.filter = 'brightness(1)';
                        handleStockLeave();
                    };
                    stockBlock.onclick = () => window.open(`https://finance.naver.com/item/main.naver?code=${sNode.data.stock_code}`, '_blank');
                    
                    
                    if (sb.w > 40 && sb.h > 30) {
                        let nameLen = sNode.data.stock_name.length;
                        let optimalRem = sb.w / (nameLen * 12);
                        const fontSizeTitle = Math.max(0.45, Math.min(1.1, optimalRem * 1.5)); // Multiply by 1.5 because we allow 2-line wrapping
                        const fontSizeRate = Math.max(0.5, Math.min(0.9, sb.w / 80));
                        
                        stockBlock.innerHTML = `
                            <div style="font-size: ${fontSizeTitle}rem; font-weight: 800; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.6); text-align: center; word-break: keep-all; overflow: hidden; max-width: 95%; line-height: 1.15; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${sNode.data.stock_name}</div>
                            <div style="font-size: ${fontSizeRate}rem; font-weight: 700; color: rgba(255,255,255,0.9); text-shadow: 0 1px 2px rgba(0,0,0,0.6); margin-top: 3px;">${sNode.data.rate > 0 ? '+'+sNode.data.rate : sNode.data.rate}%</div>
                        `;
                    }
                    themeBlock.appendChild(stockBlock);
                });
            }
            
            canvas.appendChild(themeBlock);
        });
        
    } else {
        // Grid mode
        canvas.style.display = 'grid';
        canvas.style.flex = 'none';
        canvas.style.height = 'auto';
        canvas.style.overflow = 'visible';
        canvas.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
        canvas.style.gridAutoRows = 'minmax(90px, auto)';
        canvas.style.alignContent = 'start';
        canvas.style.gap = '4px';
        canvas.style.padding = '4px';
        
        hThemes.forEach((t) => {
            const tile = document.createElement('div');
            tile.style.cssText = `
                background-color: ${getHeatmapColor(t.avg_rate)};
                border-radius: 6px;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                color: white;
                cursor: pointer;
                padding: 1rem 0.5rem;
                text-align: center;
                transition: transform 0.1s, filter 0.1s;
                overflow: hidden;
            `;
            
            tile.onmouseover = () => {
                tile.style.filter = 'brightness(1.15)';
                tile.style.transform = 'translateY(-2px)';
            };
            tile.onmouseout = () => {
                tile.style.filter = 'brightness(1)';
                tile.style.transform = 'translateY(0)';
            };
            tile.onclick = () => {
                if (currentGridViewMode === 'heatmap') toggleGridMode();
                triggerSearch(t.theme_name);
            };
            
            const leaderName = t.leader_stock || "N/A";
            
            tile.innerHTML = `
                <div style="font-size: 0.85rem; font-weight: 800; margin-bottom: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${t.theme_name}</div>
                <div style="font-size: 0.85rem; font-weight: 700; text-shadow: 0 1px 2px rgba(0,0,0,0.3); margin-bottom: 4px;">${t.avg_rate > 0 ? '+'+t.avg_rate : t.avg_rate}%</div>
                <div style="font-size: 0.7rem; opacity: 0.9; text-shadow: 0 1px 2px rgba(0,0,0,0.3); margin-bottom: 4px;">${t.total_volume_str}</div>
                <div style="font-size: 0.7rem; background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px;">👑 ${leaderName}</div>
            `;
            canvas.appendChild(tile);
        });
    }
}
function computeTreemap(nodes, x, y, width, height) {
    if (nodes.length === 0) return;
    
    function squarify(children, row, w, rx, ry, rw, rh) {
        if (children.length === 0) {
            if (row.length > 0) layoutRow(row, w, rx, ry, rw, rh);
            return;
        }
        
        const c = children[0];
        if (row.length === 0 || worst(row, w) >= worst([...row, c], w)) {
            squarify(children.slice(1), [...row, c], w, rx, ry, rw, rh);
        } else {
            const newBounds = layoutRow(row, w, rx, ry, rw, rh);
            squarify(children, [], Math.min(newBounds.width, newBounds.height), newBounds.x, newBounds.y, newBounds.width, newBounds.height);
        }
    }

    function worst(row, w) {
        if (row.length === 0) return Infinity;
        let minArea = Infinity, maxArea = 0, sumArea = 0;
        for (const item of row) {
            if (item.value < minArea) minArea = item.value;
            if (item.value > maxArea) maxArea = item.value;
            sumArea += item.value;
        }
        return Math.max(
            (w * w * maxArea) / (sumArea * sumArea),
            (sumArea * sumArea) / (w * w * minArea)
        );
    }

    function layoutRow(row, w, rx, ry, rw, rh) {
        let sumArea = row.reduce((sum, c) => sum + c.value, 0);
        let rowWidth = sumArea / w;
        
        let curX = rx, curY = ry;
        for (const item of row) {
            let itemW, itemH;
            if (rw >= rh) { // vertical layout inside row
                itemW = rowWidth;
                itemH = item.value / rowWidth;
                item.bounds = { x: curX, y: curY, w: itemW, h: itemH };
                curY += itemH;
            } else { // horizontal layout inside row
                itemH = rowWidth;
                itemW = item.value / rowWidth;
                item.bounds = { x: curX, y: curY, w: itemW, h: itemH };
                curX += itemW;
            }
        }
        
        if (rw >= rh) {
            return { x: rx + rowWidth, y: ry, width: Math.max(0, rw - rowWidth), height: rh };
        } else {
            return { x: rx, y: ry + rowWidth, width: rw, height: Math.max(0, rh - rowWidth) };
        }
    }
    
    // Normalize values to match total area
    const totalValue = nodes.reduce((sum, n) => sum + n.value, 0);
    if (totalValue === 0) return;
    const totalArea = width * height;
    
    // Create a working copy so we don't mutate original values if called multiple times
    const workingNodes = nodes.map(n => ({...n, value: (n.value / totalValue) * totalArea}));
    workingNodes.sort((a, b) => b.value - a.value);
    
    squarify(workingNodes, [], Math.min(width, height), x, y, width, height);
    
    // Copy bounds back
    workingNodes.forEach((wn, idx) => {
        nodes.find(n => n.data === wn.data).bounds = wn.bounds;
    });
}

window.addEventListener('resize', () => {
    if (activeMainView === 'grid' && currentGridViewMode === 'heatmap') {
        const canvas = document.getElementById('heatmap-canvas');
        if (canvas && canvas.clientWidth > 0) {
            renderHeatmap();
        }
    }
});

window.toggleClosingBetPin = function() {
    const section = document.getElementById('closing-bet-section');
    const btn = document.getElementById('closing-bet-pin-btn');
    if (!section || !btn) return;

    const isPinned = section.classList.toggle('pinned');
    if (isPinned) {
        btn.style.filter = 'grayscale(0%)';
        btn.style.opacity = '1';
        localStorage.setItem('investra_closing_bet_pinned', 'true');
    } else {
        btn.style.filter = 'grayscale(100%)';
        btn.style.opacity = '0.5';
        localStorage.setItem('investra_closing_bet_pinned', 'false');
    }
};

window.toggleClosingBetCollapse = function() {
    const container = document.getElementById('closing-bet-cards-container');
    const btn = document.getElementById('closing-bet-collapse-btn');
    if (!container || !btn) return;
    
    if (container.style.display === 'none') {
        container.style.display = 'flex';
        btn.textContent = '🔽';
    } else {
        container.style.display = 'none';
        btn.textContent = '🔼';
    }
};

// Initialize pin state on load
document.addEventListener('DOMContentLoaded', () => {
    const savedPin = localStorage.getItem('investra_closing_bet_pinned');
    const section = document.getElementById('closing-bet-section');
    const btn = document.getElementById('closing-bet-pin-btn');
    
    if (section && btn) {
        if (savedPin === 'false') {
            section.classList.remove('pinned');
            btn.style.filter = 'grayscale(100%)';
            btn.style.opacity = '0.5';
        } else {
            // Default is pinned (true)
            section.classList.add('pinned');
            btn.style.filter = 'grayscale(0%)';
            btn.style.opacity = '1';
        }
    }
});

// ==========================================
// News and Disclosures Modal Logic
// ==========================================

window.openNewsModal = async function(code, name) {
    const overlay = document.getElementById('news-modal-overlay');
    const titleSpan = document.querySelector('#news-modal-title .stock-name');
    const newsContainer = document.getElementById('news-list-container');
    const noticeContainer = document.getElementById('notice-list-container');

    if (!overlay) return;

    // Set title
    titleSpan.textContent = name;
    
    // Show loading state
    newsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 2rem 0;">데이터를 불러오는 중...</div>';
    noticeContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 2rem 0;">데이터를 불러오는 중...</div>';

    // Display modal
    overlay.style.display = 'flex';
    // Trigger reflow
    void overlay.offsetWidth;
    overlay.style.opacity = '1';
    overlay.querySelector('.modal-content').style.transform = 'scale(1)';

    try {
        const response = await fetch(`/api/v1/market/stocks/${code}/news`);
        const result = await response.json();
        
        if (result.status === 'success' && result.data) {
            renderNewsList(newsContainer, result.data.news, '뉴스가 없습니다.');
            renderNewsList(noticeContainer, result.data.disclosures, '공시가 없습니다.');
        } else {
            throw new Error('Invalid response');
        }
    } catch (e) {
        console.error('Failed to fetch news:', e);
        const errorMsg = '<div style="text-align: center; color: var(--accent-red); padding: 2rem 0;">데이터를 불러오는데 실패했습니다.</div>';
        newsContainer.innerHTML = errorMsg;
        noticeContainer.innerHTML = errorMsg;
    }
};

window.closeNewsModal = function() {
    const overlay = document.getElementById('news-modal-overlay');
    if (!overlay) return;
    
    overlay.style.opacity = '0';
    overlay.querySelector('.modal-content').style.transform = 'scale(0.95)';
    
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 300);
};

// Close modal when clicking outside
document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('news-modal-overlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeNewsModal();
            }
        });
    }
});

function renderNewsList(container, items, emptyMessage) {
    if (!items || items.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 2rem 0; font-size: 0.9rem;">${emptyMessage}</div>`;
        return;
    }

    const html = items.map(item => `
        <a href="${item.link}" target="_blank" style="display: block; padding: 0.75rem; background: rgba(0,0,0,0.015); border: 1px solid var(--border-color); border-radius: 8px; text-decoration: none; transition: var(--transition-fast);" onmouseover="this.style.background='var(--bg-card)'; this.style.boxShadow='var(--shadow-sm)'; this.style.borderColor='var(--accent-blue)';" onmouseout="this.style.background='rgba(0,0,0,0.015)'; this.style.boxShadow='none'; this.style.borderColor='var(--border-color)';">
            <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.4rem; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">
                ${item.title}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: var(--text-muted);">
                <span style="background: rgba(0,0,0,0.04); padding: 0.1rem 0.4rem; border-radius: 4px;">${item.publisher}</span>
                <span>${item.date}</span>
            </div>
        </a>
    `).join('');
    
    container.innerHTML = html;
}

// --- Holdings News Feature ---

let holdingsNewsTimer = null;
let holdingsNewsCountdown = 0;

async function fetchHoldingsNews() {
    try {
        const response = await fetch('/api/v1/market/holdings/news');
        const result = await response.json();
        if (result.status === 'success') {
            const newsList = result.data || [];
            renderHoldingsNewsList(newsList);
        }
    } catch (error) {
        console.error("내 주식 뉴스 로드 중 에러 발생:", error);
    }
}

function startHoldingsNewsTimer() {
    if (holdingsNewsTimer) clearInterval(holdingsNewsTimer);
    
    // 5~10초 사이의 랜덤한 초기값 설정 (정수 초)
    holdingsNewsCountdown = Math.floor(Math.random() * 6) + 5;
    updateHoldingsTimerUI();

    holdingsNewsTimer = setInterval(() => {
        holdingsNewsCountdown--;
        if (holdingsNewsCountdown <= 0) {
            // 시간이 다 되면 즉시 뉴스 갱신
            fetchHoldingsNews();
            // 다음 갱신 주기도 5~10초 사이 랜덤으로 재설정
            holdingsNewsCountdown = Math.floor(Math.random() * 6) + 5;
        }
        updateHoldingsTimerUI();
    }, 1000);
}

function stopHoldingsNewsTimer() {
    if (holdingsNewsTimer) {
        clearInterval(holdingsNewsTimer);
        holdingsNewsTimer = null;
    }
    const timerEl = document.getElementById('holdings-timer');
    if (timerEl) timerEl.innerText = '';
}

function updateHoldingsTimerUI() {
    const timerEl = document.getElementById('holdings-timer');
    if (timerEl) {
        timerEl.innerText = `(${holdingsNewsCountdown}초 후 갱신)`;
    }
}

function renderHoldingsNewsList(newsList) {
    const wrapper = document.getElementById('holdings-news-chips');
    if (!wrapper) return;
    
    if (!newsList || newsList.length === 0) {
        wrapper.innerHTML = '<div style="padding: 1.5rem; color: var(--text-muted); text-align: center; font-size: 0.8rem; font-weight: 600;">현재 보유 종목(국내)에 대한 최신 뉴스가 없습니다.</div>';
        return;
    }
    
    let html = '<div style="display: flex; flex-direction: column; width: 100%;">';
    newsList.forEach(news => {
        html += `
            <a href="${news.link}" target="_blank" class="news-item-chip" style="display: flex; flex-direction: column; padding: 0.8rem 1rem; border-bottom: 1px solid var(--border-color); text-decoration: none; transition: background-color 0.2s;">
                <div style="font-weight: 700; color: var(--text-primary); font-size: 0.85rem; margin-bottom: 0.3rem; line-height: 1.4;">
                    <span style="color: var(--accent-blue); margin-right: 0.35rem; font-weight: 800;">[${news.stock_name}]</span>${news.title}
                </div>
                <div style="font-size: 0.65rem; color: var(--text-muted); display: flex; justify-content: space-between; font-weight: 600;">
                    <span>${news.publisher || '네이버금융'}</span>
                    <span>${news.date}</span>
                </div>
            </a>
        `;
    });
    html += '</div>';
    wrapper.innerHTML = html;
}

