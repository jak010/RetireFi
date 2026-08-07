import os
import time
import logging
import requests
import xml.etree.ElementTree as ET
from typing import List, Dict, Any, Optional, Tuple
import pandas as pd
from bs4 import BeautifulSoup

from adapter.thema.royalroader import load_realtime_theme_data
from adapter.thema.dto.ranking_dto import ThemeResponseDTO
from adapter.slack.client import SlackClient
from adapter.naver.naver_finanacial_theme import ThemeStockMapper
from src.config.setup import settings
from adapter.save.save_tickers import SaveTickerService

logger = logging.getLogger(__name__)


def sort_stocks_composite(stocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """거래대금이 높으면서 등락률이 높은 종목 우선 정렬 (거래대금 순위 + 등락률 순위 복합 산출)"""
    if not stocks or len(stocks) <= 1:
        return stocks
    by_vol = sorted(stocks, key=lambda x: x.get("volume", 0), reverse=True)
    vol_rank = {s.get("stock_code"): r for r, s in enumerate(by_vol, 1)}
    by_rate = sorted(stocks, key=lambda x: x.get("rate", 0.0), reverse=True)
    rate_rank = {s.get("stock_code"): r for r, s in enumerate(by_rate, 1)}
    return sorted(stocks, key=lambda x: (
        vol_rank.get(x.get("stock_code"), 999) + rate_rank.get(x.get("stock_code"), 999),
        -x.get("volume", 0),
        -x.get("rate", 0.0)
    ))


class NaverThemeService:
    def __init__(self):
        # 100% 인메모리 매핑 데이터 구조
        self.mapping_df = pd.DataFrame()

        self.slack = SlackClient(token=settings.SLACK_TOKEN) if settings.SLACK_TOKEN else None
        
        # Slack 발송 이력 캐시 (메모리 상에 유지)
        self.slack_alert_history = {}
        self.pending_alerts = []

        # 대장주 낙폭 알람 수신 종목 코드 (라디오버튼 설정, 기본은 안받기 = 빈 집합이면 수신 없음)
        self.pullback_alert_enabled_codes: set = set()

        try:
            self.save_ticker_service = SaveTickerService()
        except Exception as e:
            logger.warning(f"SaveTickerService 초기화 실패: {e}")
            self.save_ticker_service = None

        # 인메모리 캐시 변수 초기화
        self.news_cache = None
        self.news_cache_time = 0.0
        self.news_cache_ttl = 30.0 # 속보 뉴스 TTL: 30초

        self.rr_cache = None
        self.rr_cache_time = 0.0
        self.rr_cache_ttl = 7.0 # 로얄로더 시세 TTL: 7초

        self.indices_cache = None
        self.indices_cache_time = 0.0
        self.indices_cache_ttl = 7.0 # 지수 데이터 TTL: 7초

        # 종목 통계 데이터 (종목별 3개월 최고가, 20일 평균 거래량) 캐시
        self.stock_stats_cache = {}
        self.stock_stats_ttl = 3600.0 # 1시간 캐시

        # 키움 0181 등락률 상위 캐시
        self.kiwoom_0181_cache = None
        self.kiwoom_0181_cache_time = 0.0
        self.kiwoom_0181_cache_ttl = 15.0 # 15초 캐시

        # 네이버 테마 요약 결과 캐시 (서버 사이드 글로벌 캐시)
        self.naver_themes_summary_cache = None
        self.naver_themes_summary_cache_time = 0.0
        self.naver_themes_summary_cache_ttl = 15.0 # 15초 캐시

        # 실시간 시세 및 로얄로더 종목 저장 캐시 (상따 종목 조회용)
        self.latest_naver_prices = {}
        self.latest_rr_stocks = {}

        # 실시간 데이터 로딩 진행률 (0~100)
        self.load_status = {"step": "idle", "progress": 0}

        # 백그라운드 갱신 진행 여부 플래그
        self.is_updating = False

    def get_stock_stats(self, code: str) -> Dict[str, Any]:
        """
        네이버 fchart API를 이용해 최근 60영업일(대략 3개월) 데이터를 가져와서
        3개월 최고가, 20일 평균 거래량 및 10/20일 이평선 정배열(골든) 여부를 연산한 후 캐싱하여 반환합니다.
        """
        current_time = time.time()
        if code in self.stock_stats_cache:
            ts, stats = self.stock_stats_cache[code]
            if current_time - ts < self.stock_stats_ttl:
                return stats

        stats = {"three_month_high": 0, "three_month_low": 0, "avg_vol_20": 0, "ma10_above_ma20": False, "today_high": 0}
        try:
            # count=60 영업일 (대략 3개월)
            url = f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count=60&requestType=0"
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=3.0)
            if r.status_code == 200:
                root = ET.fromstring(r.text.strip())
                items = root.findall('.//item')
                if items:
                    volumes = []
                    high_prices = []
                    low_prices = []
                    close_prices = []
                    
                    for item in items:
                        data = item.attrib.get('data', '')
                        parts = data.split('|')
                        if len(parts) >= 6:
                            try:
                                high_prices.append(int(parts[2]))
                                low_prices.append(int(parts[3]))
                                close_prices.append(int(parts[4]))
                            except ValueError:
                                pass
                                
                    # 최근 20영업일 거래량 추출
                    for item in items[-20:]:
                        data = item.attrib.get('data', '')
                        parts = data.split('|')
                        if len(parts) >= 6:
                            try:
                                volumes.append(int(parts[5]))
                            except ValueError:
                                pass
                    
                    stats["three_month_high"] = max(high_prices) if high_prices else 0
                    stats["three_month_low"] = min(low_prices) if low_prices else 0
                    stats["today_high"] = high_prices[-1] if high_prices else 0
                    stats["avg_vol_20"] = sum(volumes) / len(volumes) if volumes else 0
                    
                    # 10일 vs 20일 이평선 연산
                    if len(close_prices) >= 20:
                        ma10 = sum(close_prices[-10:]) / 10
                        ma20 = sum(close_prices[-20:]) / 20
                        stats["ma10_above_ma20"] = ma10 >= ma20
                    elif len(close_prices) >= 10:
                        ma10 = sum(close_prices[-10:]) / 10
                        ma_all = sum(close_prices) / len(close_prices)
                        stats["ma10_above_ma20"] = ma10 >= ma_all
        except Exception as e:
            logger.error(f"주식 통계 데이터 수집 실패 ({code}): {e}")

        self.stock_stats_cache[code] = (current_time, stats)
        return stats

    def ensure_mapping_data(self):
        """인메모리에 테마 매핑 데이터가 없는 경우, 실시간 크롤러를 작동시켜 메모리에 캐싱합니다. (파일 I/O 없음)"""
        if self.mapping_df.empty:
            logger.info("⚠️ 인메모리 테마 매핑 정보가 비어있습니다. 실시간 크롤링을 개시합니다...")
            try:
                mapper = ThemeStockMapper()
                def progress_cb(step, val):
                    self.load_status = {"step": step, "progress": val}
                # 1페이지 분량의 네이버 금융 테마 중 상위 15개를 메모리로 긁어옵니다.
                self.mapping_df = mapper.build_mapping_data(max_pages=1, limit_themes=15, progress_callback=progress_cb)
                self.mapping_df['stock_code'] = self.mapping_df['stock_code'].astype(str).str.zfill(6)
                logger.info(f"✅ 네이버 테마 실시간 수집 완료 및 인메모리 적재 성공 (총 {len(self.mapping_df)}개 레코드)")
            except Exception as e:
                logger.error(f"❌ 네이버 테마 실시간 스크래핑 중 오류 발생: {e}")



    def get_naver_themes_summary(self) -> Dict[str, Any]:
        """
        로얄로더 실시간 활성 종목 시세를 네이버 세부 테마에 매핑하여 테마별 요약 정보 및 Top 5 종목 상세 정보를 연산하고,
        거래대금 기준 정렬 테마 목록, 대금 상위 5대 테마, 통합 주도섹터 3대 테마를 산출합니다.
        Vercel/서버리스 환경에서는 백그라운드 스레드를 사용하지 않고 동기식(Lazy Loading)으로 데이터를 즉시 갱신하여 반환합니다.
        """
        if os.getenv("USE_DUMMY", "false").lower() == "true":
            return self.get_dummy_themes_data()

        current_time = time.time()
        is_vercel = os.getenv("VERCEL") is not None

        # 1. 캐시가 존재하고 신선한(Fresh) 경우 즉시 리턴
        if self.naver_themes_summary_cache and (current_time - self.naver_themes_summary_cache_time < self.naver_themes_summary_cache_ttl):
            return self.naver_themes_summary_cache

        # Vercel/서버리스 환경인 경우: 백그라운드 스레드 대신 동기식(Lazy Loading)으로 즉시 갱신 후 리턴
        if is_vercel:
            logger.info("⚡ [Serverless/Vercel] 캐시가 없거나 만료되어 동기식(Lazy Loading) 시세 갱신을 실행합니다...")
            return self._calculate_themes_summary()

        # 2. 캐시가 존재하지만 오래된(Stale) 경우, 백그라운드에서 갱신하고 기존 캐시 즉시 리턴 (Stale-While-Revalidate)
        if self.naver_themes_summary_cache:
            if not self.is_updating:
                import threading
                self.is_updating = True
                threading.Thread(target=self._run_cache_update_bg, daemon=True).start()
            return self.naver_themes_summary_cache

        # 3. 최초 기동 등으로 캐시가 전혀 없는 경우: 백그라운드에서 갱신을 실행하고 loading 상태 즉시 반환
        if not self.is_updating:
            import threading
            self.is_updating = True
            self.load_status = {"step": "idle", "progress": 0}
            threading.Thread(target=self._run_cache_update_bg, daemon=True).start()

        return {
            "status": "loading",
            "step": self.load_status.get("step", "idle"),
            "progress": self.load_status.get("progress", 0)
        }


    def _run_cache_update_bg(self):
        try:
            logger.info("⏳ [BG-UPDATE] 백그라운드 캐시 업데이트 스레드 작동 개시...")
            data = self._calculate_themes_summary()
            if data:
                logger.info("✅ [BG-UPDATE] 백그라운드 캐시 업데이트 완료!")
        except Exception as e:
            logger.error(f"❌ [BG-UPDATE] 백그라운드 캐시 업데이트 에러: {e}")
        finally:
            self.is_updating = False

    def _calculate_themes_summary(self) -> Dict[str, Any]:
        """네이버 테마 요약 실시간 계산 (동기 처리 본문)"""
        self.ensure_mapping_data()
        if self.mapping_df.empty:
            return {"themes": [], "top_themes_5": [], "leader_sectors_3": []}

        # 1. 로얄로더 실시간 데이터 수집 (캐시 검사)
        current_time = time.time()
        if self.rr_cache and (current_time - self.rr_cache_time < self.rr_cache_ttl):
            rr_themes = self.rr_cache
        else:
            rr_themes = load_realtime_theme_data() or []
            self.rr_cache = rr_themes
            self.rr_cache_time = current_time
        
        # 2. 로얄로더 및 네이버 종목 코드 통합 수집
        rr_stock_map = {}
        all_active_codes = []
        
        # 2.1. 네이버 매핑 DB 종목 코드 수집
        if not self.mapping_df.empty:
            for code in self.mapping_df['stock_code'].unique():
                if code not in all_active_codes:
                    all_active_codes.append(code)

        # 2.2. 로얄로더 종목 정보 수집
        for rt in rr_themes:
            for s in rt.stocks:
                code_6d = s.stock_code[-6:]
                if code_6d not in rr_stock_map or s.trade_volume_krw > rr_stock_map[code_6d].trade_volume_krw:
                    rr_stock_map[code_6d] = s
                if code_6d not in all_active_codes:
                    all_active_codes.append(code_6d)
        self.latest_rr_stocks = rr_stock_map

        # 2.1. 종목 통계 데이터 병렬 사전 수집 (ThreadPoolExecutor)
        codes_to_fetch = []
        for code in all_active_codes:
            if code not in self.stock_stats_cache:
                codes_to_fetch.append(code)
            else:
                ts, _ = self.stock_stats_cache[code]
                if current_time - ts >= self.stock_stats_ttl:
                    codes_to_fetch.append(code)

        if codes_to_fetch:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            logger.info(f"⚡ [STATS PRE-FETCH] {len(codes_to_fetch)}개 종목 통계 병렬 수집 시작...")
            with ThreadPoolExecutor(max_workers=15) as executor:
                futures = {executor.submit(self.get_stock_stats, code): code for code in codes_to_fetch}
                
                completed_count = 0
                total_to_fetch = len(futures)
                for future in as_completed(futures):
                    completed_count += 1
                    prog = 40 + int((completed_count / total_to_fetch) * 50)
                    self.load_status = {"step": "stats", "progress": min(95, prog)}
            logger.info("✅ [STATS PRE-FETCH] 병렬 수집 완료!")
        else:
            self.load_status = {"step": "stats", "progress": 90}

        # 네이버 금융 실시간 데이터 일괄 조회 (예외 방어 및 차단 대비 Fallback)
        naver_prices = {}
        try:
            naver_prices = self.fetch_naver_realtime_prices(all_active_codes)
            if naver_prices:
                self.latest_naver_prices = naver_prices
        except Exception as e:
            logger.error(f"네이버 금융 실시간 시세 일괄 조회 예외 발생: {e}")

        # 만약 네이버 시세 수집이 완전히 실패했고, Stale 캐시가 존재한다면 Stale 캐시를 강제 연장 서빙하여 복구!
        if not naver_prices and self.naver_themes_summary_cache:
            logger.warning("⚠️ 네이버 금융 시세 수집 실패로 인해 Stale 캐시(이전 캐시)를 강제 재활용하여 리턴합니다.")
            return self.naver_themes_summary_cache

        # 3. 네이버 테마별 집계
        theme_groups = self.mapping_df.groupby('theme_name')
        summary_list = []

        for theme_name, group in theme_groups:
            total_rate = 0.0
            total_volume = 0
            mapped_count = 0
            leader_stock = ""
            max_rate = -999.0
            theme_stocks = []
            
            # 테마에 속한 모든 종목 집계 (로얄로더 제한 해제)
            for _, row in group.iterrows():
                code = row['stock_code']
                name = row['stock_name']
                desc = row['description']
                if not isinstance(desc, str):
                    desc = ""
                
                naver_data = naver_prices.get(code)
                s_data = rr_stock_map.get(code)
                
                if naver_data or s_data:
                    price_won = 0
                    rate_val = 0.0
                    amount_won = 0
                    volume_shares = 0
                    
                    if naver_data:
                        price_won = naver_data.get("price") or 0
                        rate_val = naver_data.get("rate") or 0.0
                        amount_won = naver_data.get("amount") or 0
                        volume_shares = naver_data.get("volume") or 0
                    
                    if s_data:
                        if not price_won:
                            price_won = s_data.current_price_krw
                        if rate_val == 0.0 and s_data.stock_rate != 0.0:
                            rate_val = s_data.stock_rate
                        if not amount_won:
                            amount_won = int(s_data.trade_volume_krw * 1000000)
                    
                    if not price_won:
                        continue
                        
                    # 추가 통계 정보 (3개월 최고가, 20일 평균 거래량) 조회
                    stats = self.get_stock_stats(code)
                    
                    three_month_high = stats.get("three_month_high", 0)
                    three_month_low = stats.get("three_month_low", 0)
                    avg_vol_20 = stats.get("avg_vol_20", 0)
                    
                    if three_month_high > three_month_low > 0:
                        pos_ratio = ((price_won - three_month_low) / (three_month_high - three_month_low)) * 100
                    else:
                        pos_ratio = 50.0
                    pos_ratio = max(0.0, min(100.0, pos_ratio))

                    if pos_ratio >= 70.0:
                        price_level = "머리"
                        price_level_desc = "고점 부근 (매수 유의)"
                    elif pos_ratio >= 35.0:
                        price_level = "어깨"
                        price_level_desc = "중간 추세 구간"
                    else:
                        price_level = "무릎"
                        price_level_desc = "저점 부근 (매수 관심)"
                    
                    # 거래량 수급 비율 계산
                    volume_ratio = (volume_shares / avg_vol_20 * 100) if avg_vol_20 > 0 else 0.0
                    
                    total_rate += rate_val
                    total_volume += amount_won
                    mapped_count += 1
                    
                    if rate_val > max_rate:
                        max_rate = rate_val
                        leader_stock = name
                        
                    theme_stocks.append({
                        "stock_code": code,
                        "stock_name": name,
                        "description": desc,
                        "rate": rate_val,
                        "rate_str": f"{rate_val:+.2f}%",
                        "price": price_won,
                        "price_str": f"{price_won:,}원",
                        "volume": amount_won, # 기존 대금 (원 단위)
                        "volume_shares": volume_shares, # 누적거래량 (주 단위)
                        "three_month_high": three_month_high,
                        "three_month_high_str": f"{three_month_high:,}원" if three_month_high > 0 else "-",
                        "three_month_low": three_month_low,
                        "three_month_low_str": f"{three_month_low:,}원" if three_month_low > 0 else "-",
                        "price_level": price_level,
                        "price_level_desc": price_level_desc,
                        "price_position_ratio": round(pos_ratio, 1),
                        "ma10_above_ma20": stats.get("ma10_above_ma20", False),
                        "avg_volume": avg_vol_20,
                        "avg_volume_str": f"{int(avg_vol_20):,}주" if avg_vol_20 > 0 else "-",
                        "volume_ratio": round(volume_ratio, 2),
                        "volume_ratio_str": f"{volume_ratio:.1f}%" if avg_vol_20 > 0 else "-",
                        "naver_high": (naver_data.get("high") if naver_data else 0) or stats.get("today_high", 0)
                    })

            # 시세가 수집되는 활성 종목이 1개라도 있는 테마만 필터링하여 노출
            if mapped_count > 0:
                avg_rate = total_rate / mapped_count
                
                # 조/억 단위 포맷팅
                t_trillion = int(total_volume // 1000000000000)
                t_billion = int((total_volume % 1000000000000) // 100000000)
                vol_str = f"{t_trillion}조 {t_billion:,}억 원" if t_trillion > 0 else f"{t_billion:,}억 원"

                # 거래대금 및 등락률 복합 상위 정렬 후 상위 5개 추출
                theme_stocks = sort_stocks_composite(theme_stocks)
                top_5_stocks = theme_stocks[:5]

                # 각 상위 종목 역할 및 매수 타점 계산
                for idx, s in enumerate(top_5_stocks):
                    if idx == 0:
                        s["role"] = "👑 대장주"
                    elif idx == 1:
                        s["role"] = "🥇 1등주"
                    elif idx == 2:
                        s["role"] = "🥈 2등주"
                    else:
                        s["role"] = "후발주"

                    # 거래대금 포맷 변환 (억 단위 기준)
                    s_volume = s.get("volume", 0)
                    s_trillion = int(s_volume // 1000000000000)
                    s_billion = int((s_volume % 1000000000000) // 100000000)
                    s_volume_str = f"{s_trillion}조 {s_billion:,}억" if s_trillion > 0 else f"{s_billion:,}억"
                    if s_trillion == 0 and s_billion == 0:
                        s_million = int((s_volume % 100000000) // 1000000)
                        s_volume_str = f"{s_million}백만" if s_million > 0 else "0억"
                    s["volume_str"] = s_volume_str

                    # 장중 고점 및 낙폭 계산
                    safe_price = max(1, s["price"])
                    day_high = s.get("naver_high", 0)

                    if day_high < safe_price:
                        day_high = safe_price
                    day_high = max(1, day_high)

                    intraday_drop = ((safe_price - day_high) / day_high) * 100
                    s["day_high"] = day_high
                    s["day_high_str"] = f"{day_high:,}원" if safe_price > 0 else "-"
                    s["drop"] = round(intraday_drop, 2)
                    s["drop_str"] = f"{intraday_drop:.2f}%"

                    # 1차 낙폭(-4.4~-8%), 2차 낙폭(-8~-12%) 매수 밴드 산출
                    high_minus_4pct = int(day_high * 0.956)
                    high_minus_8pct = int(day_high * 0.92)
                    high_minus_12pct = int(day_high * 0.88)

                    s["buy_zone_1"] = f"{high_minus_8pct:,} ~ {high_minus_4pct:,}원"
                    s["buy_zone_2"] = f"{high_minus_12pct:,} ~ {high_minus_8pct:,}원"

                    # 실시간 매수타점 Slack 알림 발송 체크
                    self.trigger_slack_alerts_if_needed(s, theme_name)

                up_count = sum(1 for s in theme_stocks if s["rate"] > 0)
                down_count = sum(1 for s in theme_stocks if s["rate"] < 0)
                flat_count = sum(1 for s in theme_stocks if s["rate"] == 0)

                summary_list.append({
                    "theme_name": theme_name,
                    "avg_rate": round(avg_rate, 2),
                    "total_volume": total_volume,
                    "total_volume_str": vol_str,
                    "mapped_count": mapped_count,
                    "total_count": len(group),
                    "leader_stock": leader_stock or "N/A",
                    "top_stocks": top_5_stocks,
                    "source": "naver",
                    "up_count": up_count,
                    "down_count": down_count,
                    "flat_count": flat_count
                })

        # 8. 실시간 속보 뉴스 연동 (인메모리 캐싱 검사)
        recent_news_data = []
        if self.news_cache and (current_time - self.news_cache_time < self.news_cache_ttl):
            recent_news_data = self.news_cache
        else:
            try:
                recent_news_data = self.fetch_naver_breaking_news()
                if recent_news_data:
                    self.news_cache = recent_news_data
                    self.news_cache_time = current_time
                else:
                    if self.news_cache:
                        recent_news_data = self.news_cache
            except Exception as e:
                logger.error(f"네이버 속보 뉴스 수집 실패: {e}")
                if self.news_cache:
                    recent_news_data = self.news_cache

        # 9. 실시간 글로벌 지수 연동 (코스피, 나스닥 선물, 필라델피아 반도체)
        indices_data = {}
        if self.indices_cache and (current_time - self.indices_cache_time < self.indices_cache_ttl):
            indices_data = self.indices_cache
        else:
            symbols = {
                "kospi": "^KS11",
                "nasdaq_futures": "NQ=F",
                "philadelphia_semiconductor": "^SOX"
            }
            for key, sym in symbols.items():
                indices_data[key] = self.fetch_yahoo_index(sym)
            self.indices_cache = indices_data
            self.indices_cache_time = current_time

        # 9.1. 로얄로더 테마 가공 및 집계
        royal_themes_list = []
        for rt in rr_themes:
            total_rate = 0.0
            total_volume = 0
            mapped_count = 0
            theme_stocks = []
            
            for s in rt.stocks:
                code = s.stock_code[-6:]
                name = s.stock_name
                
                naver_data = naver_prices.get(code, {})
                price_won = naver_data.get("price") or s.current_price_krw
                rate_val = naver_data.get("rate") if naver_data.get("rate") is not None else s.stock_rate
                amount_won = naver_data.get("amount") or (s.trade_volume_krw * 1000000)
                volume_shares = naver_data.get("volume") or 0
                
                stats = self.get_stock_stats(code)
                three_month_high = stats.get("three_month_high", 0)
                avg_vol_20 = stats.get("avg_vol_20", 0)
                volume_ratio = (volume_shares / avg_vol_20 * 100) if avg_vol_20 > 0 else 0.0
                
                total_rate += rate_val
                total_volume += amount_won
                mapped_count += 1
                
                drop = 0.0
                if three_month_high > 0:
                    drop = ((price_won - three_month_high) / three_month_high) * 100
                
                buy_zone_1 = "-"
                buy_zone_2 = "-"
                if three_month_high > 0:
                    bz1_low = int(three_month_high * 0.92)
                    bz1_high = int(three_month_high * 0.956)
                    bz2_low = int(three_month_high * 0.88)
                    bz2_high = int(three_month_high * 0.92)
                    buy_zone_1 = f"{bz1_low:,} ~ {bz1_high:,}원"
                    buy_zone_2 = f"{bz2_low:,} ~ {bz2_high:,}원"
                
                s_trillion = int(amount_won // 1000000000000)
                s_billion = int((amount_won % 1000000000000) // 100000000)
                s_volume_str = f"{s_trillion}조 {s_billion:,}억" if s_trillion > 0 else f"{s_billion:,}억"
                if s_trillion == 0 and s_billion == 0:
                    s_million = int((amount_won % 100000000) // 1000000)
                    s_volume_str = f"{s_million}백만" if s_million > 0 else "0억"

                theme_stocks.append({
                    "stock_code": code,
                    "stock_name": name,
                    "description": "",
                    "rate": rate_val,
                    "rate_str": f"{rate_val:+.2f}%",
                    "price": price_won,
                    "price_str": f"{price_won:,}원",
                    "volume": amount_won,
                    "volume_shares": volume_shares,
                    "three_month_high": three_month_high,
                    "three_month_high_str": f"{three_month_high:,}원" if three_month_high > 0 else "-",
                    "ma10_above_ma20": stats.get("ma10_above_ma20", False),
                    "avg_volume": avg_vol_20,
                    "avg_volume_str": f"{int(avg_vol_20):,}주" if avg_vol_20 > 0 else "-",
                    "volume_ratio": round(volume_ratio, 2),
                    "volume_ratio_str": f"{volume_ratio:.1f}%" if avg_vol_20 > 0 else "-",
                    "drop": drop,
                    "drop_str": f"{drop:+.2f}%",
                    "buy_zone_1": buy_zone_1,
                    "buy_zone_2": buy_zone_2,
                    "volume_str": s_volume_str
                })
            
            if mapped_count > 0:
                avg_rate = total_rate / mapped_count
                
                t_trillion = int(total_volume // 1000000000000)
                t_billion = int((total_volume % 1000000000000) // 100000000)
                vol_str = f"{t_trillion}조 {t_billion:,}억 원" if t_trillion > 0 else f"{t_billion:,}억 원"
                
                theme_stocks = sort_stocks_composite(theme_stocks)
                top_5_stocks = theme_stocks[:5]
                
                for idx, s in enumerate(top_5_stocks):
                    if idx == 0:
                        s["role"] = "👑 대장주"
                    elif idx == 1:
                        s["role"] = "🥇 1등주"
                    elif idx == 2:
                        s["role"] = "🥈 2등주"
                    else:
                        s["role"] = "후발주"
                    self.trigger_slack_alerts_if_needed(s, rt.name)
                
                up_count = sum(1 for s in theme_stocks if s["rate"] > 0)
                down_count = sum(1 for s in theme_stocks if s["rate"] < 0)
                flat_count = sum(1 for s in theme_stocks if s["rate"] == 0)

                royal_themes_list.append({
                    "theme_name": rt.name,
                    "avg_rate": round(avg_rate, 2),
                    "total_volume": total_volume,
                    "total_volume_str": vol_str,
                    "mapped_count": mapped_count,
                    "total_count": len(rt.stocks),
                    "leader_stock": rt.leader_stock or "N/A",
                    "top_stocks": top_5_stocks,
                    "source": "royal",
                    "up_count": up_count,
                    "down_count": down_count,
                    "flat_count": flat_count
                })

        # 테마명 기준 병합 처리
        merged_themes_map = {}
        for nt in summary_list:
            name = nt["theme_name"]
            merged_themes_map[name] = nt

        for rt in royal_themes_list:
            name = rt["theme_name"]
            if name in merged_themes_map:
                existing = merged_themes_map[name]
                existing["source"] = "both"
                
                # Combine stocks and deduplicate by stock_code
                stock_dict = {}
                for s in existing["top_stocks"]:
                    stock_dict[s["stock_code"]] = s
                    
                for s in rt["top_stocks"]:
                    code = s["stock_code"]
                    if code in stock_dict:
                        existing_stock = stock_dict[code]
                        if not existing_stock.get("description") and s.get("description"):
                            existing_stock["description"] = s["description"]
                        if "대장주" in s.get("role", "") or "1등주" in s.get("role", ""):
                            existing_stock["role"] = s["role"]
                    else:
                        stock_dict[code] = s
                
                merged_stocks = sort_stocks_composite(list(stock_dict.values()))
                existing["top_stocks"] = merged_stocks[:5]
                
                unique_stocks = list(stock_dict.values())
                existing["mapped_count"] = len(unique_stocks)
                existing["total_count"] = max(existing["total_count"], rt["total_count"])
                
                total_rate = sum(s["rate"] for s in unique_stocks)
                existing["avg_rate"] = round(total_rate / len(unique_stocks), 2) if unique_stocks else 0.0
                
                total_vol = sum(s["volume"] for s in unique_stocks)
                existing["total_volume"] = total_vol
                
                t_trillion = int(total_vol // 1000000000000)
                t_billion = int((total_vol % 1000000000000) // 100000000)
                vol_str = f"{t_trillion}조 {t_billion:,}억 원" if t_trillion > 0 else f"{t_billion:,}억 원"
                existing["total_volume_str"] = vol_str
                
                if unique_stocks:
                    existing["leader_stock"] = max(unique_stocks, key=lambda x: x["rate"])["stock_name"]
                    
                existing["up_count"] = sum(1 for s in unique_stocks if s["rate"] > 0)
                existing["down_count"] = sum(1 for s in unique_stocks if s["rate"] < 0)
                existing["flat_count"] = sum(1 for s in unique_stocks if s["rate"] == 0)
            else:
                merged_themes_map[name] = rt
                
        combined_themes = list(merged_themes_map.values())

        if not combined_themes:
            return {"themes": [], "top_themes_5": [], "leader_sectors_3": []}

        # 전체 활성 테마 거래대금 총합 계산
        total_market_volume = sum(item['total_volume'] for item in combined_themes)
        if total_market_volume <= 0:
            total_market_volume = 1

        # 테마별 점유율(%) 산출
        for item in combined_themes:
            item['volume_share'] = round((item['total_volume'] / total_market_volume) * 100, 1)

        # 순위별 가공 연산 (거래대금 순 정렬 및 볼륨 랭크 부여)
        sorted_by_volume = sorted(combined_themes, key=lambda x: x['total_volume'], reverse=True)
        for rank, item in enumerate(sorted_by_volume, 1):
            item['vol_rank'] = rank

        # 등락률 순위 매기기
        sorted_by_rate = sorted(combined_themes, key=lambda x: x['avg_rate'], reverse=True)
        for rank, item in enumerate(sorted_by_rate, 1):
            item['rate_rank'] = rank

        # 종합 점수 산출
        for item in combined_themes:
            item['composite_rank'] = item['rate_rank'] + item['vol_rank']

        top_themes_5 = sorted_by_volume[:5]

        # 통합 순위(composite_rank) 기준 정렬하여 주도섹터 TOP 3 산출
        sorted_by_composite = sorted(combined_themes, key=lambda x: (x['composite_rank'], -x['total_volume']))
        leader_sectors_3 = sorted_by_composite[:3]

        result = {
            "themes": sorted_by_volume,
            "top_themes_5": top_themes_5,
            "leader_sectors_3": leader_sectors_3,
            "recent_news": recent_news_data,
            "indices": indices_data,
            "royal_themes": []
        }
        self.naver_themes_summary_cache = result
        self.naver_themes_summary_cache_time = current_time
        self.load_status = {"step": "done", "progress": 100}
        self.flush_pending_alerts()
        return result

    def get_sangtta_candidates_from_naver_and_royal(self, min_rate: float = 24.0) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str], Dict[str, List[str]]]:
        """네이버 금융 및 로얄로더 시세 데이터에서 당일 등락률 min_rate(24%) 이상인 급등 후보 종목 조회"""
        self.get_naver_themes_summary()  # 캐시 갱신 또는 확인
        candidates = {}

        stock_name_map = {}
        stock_themes_map = {}
        if not self.mapping_df.empty:
            for _, row in self.mapping_df.iterrows():
                code = row["stock_code"]
                name = row["stock_name"]
                theme = row["theme_name"]
                stock_name_map[code] = name
                if code not in stock_themes_map:
                    stock_themes_map[code] = []
                if theme and theme not in stock_themes_map[code]:
                    stock_themes_map[code].append(theme)

        # 1. 네이버 실시간 시세 (latest_naver_prices 및 테마 캐시) 검사
        for code, data in getattr(self, "latest_naver_prices", {}).items():
            rate = float(data.get("rate") or 0.0)
            if rate >= min_rate:
                name = data.get("name") or stock_name_map.get(code, code)
                price = int(data.get("price") or 0)
                amount = int(data.get("amount") or 0)
                candidates[code] = {
                    "symbol": code,
                    "name": name,
                    "price": price,
                    "rate": round(rate, 2),
                    "volume": amount,
                    "sources": {"네이버"},
                    "themes": stock_themes_map.get(code, [])
                }

        # 요약 캐시 내 상위 종목에서도 재검증 및 테마 병합
        if self.naver_themes_summary_cache:
            for t_item in self.naver_themes_summary_cache.get("themes", []):
                t_name = t_item.get("theme_name")
                for s in t_item.get("top_stocks", []):
                    code = s.get("stock_code")
                    rate_val = float(s.get("rate") or 0.0)
                    if rate_val >= min_rate:
                        if code not in candidates:
                            candidates[code] = {
                                "symbol": code,
                                "name": s.get("stock_name") or stock_name_map.get(code, code),
                                "price": int(s.get("price") or 0),
                                "rate": round(rate_val, 2),
                                "volume": int(s.get("volume") or 0),
                                "sources": {"네이버"},
                                "themes": stock_themes_map.get(code, [])
                            }
                        else:
                            candidates[code]["sources"].add("네이버")
                        if t_name and t_name not in candidates[code]["themes"]:
                            candidates[code]["themes"].append(t_name)

        # 2. 로얄로더 실시간 데이터 검사
        rr_stocks = getattr(self, "latest_rr_stocks", {})
        if not rr_stocks and hasattr(self, "rr_cache") and self.rr_cache:
            for rt in self.rr_cache:
                for s in rt.stocks:
                    rr_stocks[s.stock_code[-6:]] = s

        for code, s in rr_stocks.items():
            rate_val = float(getattr(s, "stock_rate", 0.0) or 0.0)
            if code in getattr(self, "latest_naver_prices", {}):
                naver_rate = float(self.latest_naver_prices[code].get("rate") or 0.0)
                rate_val = max(rate_val, naver_rate)
            
            if rate_val >= min_rate or code in candidates:
                if code not in candidates:
                    price = int(getattr(s, "current_price_krw", 0) or 0)
                    amount = int((getattr(s, "trade_volume_krw", 0) or 0) * 1000000)
                    name = getattr(s, "stock_name", None) or stock_name_map.get(code, code)
                    candidates[code] = {
                        "symbol": code,
                        "name": name,
                        "price": price,
                        "rate": round(rate_val, 2),
                        "volume": amount,
                        "sources": {"로얄로더"},
                        "themes": stock_themes_map.get(code, [])
                    }
                else:
                    candidates[code]["sources"].add("로얄로더")
                    if round(rate_val, 2) > candidates[code]["rate"]:
                        candidates[code]["rate"] = round(rate_val, 2)

        return candidates, stock_name_map, stock_themes_map

    def fetch_yahoo_index(self, symbol: str) -> Dict[str, Any]:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1m&range=1d"
        try:
            r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=3.0)
            if r.status_code == 200:
                result = r.json()["chart"]["result"][0]["meta"]
                curr = result.get("regularMarketPrice")
                prev = result.get("chartPreviousClose")
                if curr is not None and prev is not None:
                    change = curr - prev
                    rate = (change / prev) * 100
                    return {
                        "price": curr,
                        "change": change,
                        "rate": rate,
                        "price_str": f"{curr:,.2f}",
                        "change_str": f"{change:+,.2f}",
                        "rate_str": f"{rate:+.2f}%"
                    }
        except Exception as e:
            logger.error(f"지수 수집 실패 ({symbol}): {e}")
        return {"price": 0.0, "change": 0.0, "rate": 0.0, "price_str": "-", "change_str": "-", "rate_str": "-"}

    def fetch_naver_realtime_prices(self, codes: List[str]) -> Dict[str, Dict[str, Any]]:
        """
        네이버 금융 실시간 시세 API를 사용하여 복수 종목의 현재가, 등락률, 거래량, 거래대금을 일괄 스크래핑합니다.
        (네이버 API 제한을 방지하기 위해 30개 단위로 청킹하여 조회합니다.)
        """
        if not codes:
            return {}
        
        # 중복 제거 및 zfill
        unique_codes = list(set([c.zfill(6) for c in codes]))
        
        chunk_size = 30
        result_map = {}
        
        for i in range(0, len(unique_codes), chunk_size):
            chunk = unique_codes[i:i + chunk_size]
            query_str = f"SERVICE_ITEM:{','.join(chunk)}"
            url = f"https://polling.finance.naver.com/api/realtime?query={query_str}"
            
            try:
                r = requests.get(
                    url, 
                    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}, 
                    timeout=4.0
                )
                if r.status_code == 200:
                    data = r.json()
                    areas = data.get("result", {}).get("areas", [])
                    for area in areas:
                        for item in area.get("datas", []):
                            code = item.get("cd")
                            name = item.get("nm", "")
                            price = item.get("nv", 0)
                            high = item.get("hv", 0)
                            rate = float(item.get("cr", 0.0) or 0.0)
                            rf = str(item.get("rf", ""))
                            # 네이버 API의 rf (Rise/Fall) 코드: '4'(하한), '5'(하락)이거나 현재가(nv)가 전일종가(sv)보다 낮으면 음수 변환
                            if rf in ("4", "5") or (price > 0 and item.get("sv", 0) > price):
                                rate = -abs(rate)
                            amount = item.get("aa", 0) # 거래대금(원 단위)
                            volume = item.get("aq", 0) # 누적거래량(주 단위)
                            
                            result_map[code] = {
                                "name": name,
                                "price": price,
                                "high": high,
                                "rate": rate,
                                "amount": amount,
                                "volume": volume
                            }
                time.sleep(0.05) # 미세한 딜레이 부여
            except Exception as e:
                logger.error(f"네이버 금융 실시간 시세 청크 조회 실패: {e}")
                
        return result_map

    def get_theme_stocks_detail(self, theme_name: str) -> List[Dict[str, Any]]:
        """
        특정 네이버 테마에 속하는 종목 리스트와 네이버 금융/로얄로더 실시간 결합 상세 정보를 조회합니다.
        """
        self.ensure_mapping_data()
        if self.mapping_df.empty:
            return []

        # 해당 테마의 종목 정보 필터링
        theme_group = self.mapping_df[self.mapping_df['theme_name'] == theme_name]
        if theme_group.empty:
            return []

        stock_codes = theme_group['stock_code'].tolist()
        stock_name_map = dict(zip(theme_group['stock_code'], theme_group['stock_name']))
        stock_desc_map = dict(zip(theme_group['stock_code'], theme_group['description']))

        # 1. 로얄로더 실시간 데이터 로드
        rr_themes = load_realtime_theme_data() or []
        rr_stock_map = {}
        global_leader = ""
        
        for rt in rr_themes:
            if rt.leader_stock:
                global_leader = rt.leader_stock
            for s in rt.stocks:
                rr_stock_map[s.stock_code[-6:]] = s

        # 2. 네이버 금융 실시간 시세 일괄 조회
        naver_prices = self.fetch_naver_realtime_prices(stock_codes)

        # 3. 종목별 연산 및 가공
        stock_details = []
        for code in stock_codes:
            name = stock_name_map[code]
            desc = stock_desc_map.get(code, "")
            if not isinstance(desc, str):
                desc = ""
            
            # 네이버 데이터 및 로얄로더 매핑
            naver_data = naver_prices.get(code)
            rr_data = rr_stock_map.get(code)
            
            # 현재가 결정 (네이버 시세 우선 ➡️ 로얄로더 ➡️ 0)
            price_won = naver_data["price"] if naver_data else 0
            if not price_won and rr_data:
                price_won = rr_data.current_price_krw
            price_won = price_won or 0

            # 등락률 결정 (네이버 시세 우선 ➡️ 로얄로더 ➡️ 0.0)
            rr_rate = naver_data["rate"] if naver_data else 0.0
            if not naver_data and rr_data:
                rr_rate = rr_data.stock_rate

            # 거래대금 결정 (네이버 시세 우선 ➡️ 로얄로더 ➡️ 0)
            rr_amount = naver_data["amount"] if naver_data and "amount" in naver_data else 0
            if not rr_amount and naver_data and "volume" in naver_data: # 하위 호환용
                rr_amount = naver_data["volume"]
            if not rr_amount and rr_data:
                rr_amount = rr_data.trade_volume_krw * 1000000
                
            # 실제 주 단위 거래량
            volume_shares = naver_data["volume"] if naver_data and "volume" in naver_data else 0

            # 추가 통계 정보 (3개월 최고가, 20일 평균 거래량) 조회
            stats = self.get_stock_stats(code)
            three_month_high = stats.get("three_month_high", 0)
            three_month_low = stats.get("three_month_low", 0)
            avg_vol_20 = stats.get("avg_vol_20", 0)

            if three_month_high > three_month_low > 0:
                pos_ratio = ((price_won - three_month_low) / (three_month_high - three_month_low)) * 100
            else:
                pos_ratio = 50.0
            pos_ratio = max(0.0, min(100.0, pos_ratio))

            if pos_ratio >= 70.0:
                price_level = "머리"
                price_level_desc = "고점 부근 (매수 유의)"
            elif pos_ratio >= 35.0:
                price_level = "어깨"
                price_level_desc = "중간 추세 구간"
            else:
                price_level = "무릎"
                price_level_desc = "저점 부근 (매수 관심)"
            
            # 거래량 수급 비율 계산
            volume_ratio = (volume_shares / avg_vol_20 * 100) if avg_vol_20 > 0 else 0.0

            # 거래대금 포맷 변환
            t_trillion = int(rr_amount // 1000000000000)
            t_billion = int((rr_amount % 1000000000000) // 100000000)
            volume_str = f"{t_trillion}조 {t_billion:,}억 원" if t_trillion > 0 else f"{t_billion:,}억 원"

            # 장중 고점 및 낙폭 계산 (Zero-Safe Guard)
            safe_price = max(1, price_won)
            day_high = (naver_data.get("high") if naver_data else 0) or stats.get("today_high", 0)

            if day_high < safe_price:
                day_high = safe_price
            day_high = max(1, day_high)

            intraday_drop = ((safe_price - day_high) / day_high) * 100

            # 매수 밴드 산출 (1차 낙폭 -4.4~-8%, 2차 낙폭 -8~-12%)
            high_minus_4pct = int(day_high * 0.956)
            high_minus_8pct = int(day_high * 0.92)
            high_minus_12pct = int(day_high * 0.88)

            stock_details.append({
                "stock_code": code,
                "stock_name": name,
                "description": desc,
                "price": price_won,
                "price_str": f"{price_won:,}원" if price_won > 0 else "-",
                "rate": rr_rate,
                "rate_str": f"{rr_rate:+.2f}%",
                "volume": rr_amount,
                "volume_str": volume_str if rr_amount > 0 else "-",
                "volume_shares": volume_shares,
                "three_month_high": three_month_high,
                "three_month_high_str": f"{three_month_high:,}원" if three_month_high > 0 else "-",
                "three_month_low": three_month_low,
                "three_month_low_str": f"{three_month_low:,}원" if three_month_low > 0 else "-",
                "price_level": price_level,
                "price_level_desc": price_level_desc,
                "price_position_ratio": round(pos_ratio, 1),
                "ma10_above_ma20": stats.get("ma10_above_ma20", False),
                "avg_volume": avg_vol_20,
                "avg_volume_str": f"{int(avg_vol_20):,}주" if avg_vol_20 > 0 else "-",
                "volume_ratio": round(volume_ratio, 2),
                "volume_ratio_str": f"{volume_ratio:.1f}%" if avg_vol_20 > 0 else "-",
                "market_rank": None,
                "day_high": day_high,
                "day_high_str": f"{day_high:,}원" if price_won > 0 else "-",
                "drop": round(intraday_drop, 2),
                "drop_str": f"{intraday_drop:.2f}%" if price_won > 0 else "-",
                "buy_zone_1": f"{high_minus_8pct:,} ~ {high_minus_4pct:,}원" if price_won > 0 else "-",
                "buy_zone_2": f"{high_minus_12pct:,} ~ {high_minus_8pct:,}원" if price_won > 0 else "-",
                "is_global_leader": (name == global_leader)
            })

        # 테마 내 거래대금 및 등락률 복합 상위 정렬
        stock_details = sort_stocks_composite(stock_details)

        # 역할 동적 부여 (등락률 1위: 대장주, 2위: 1등주, 3위: 2등주, 그 외 후발주)
        # 단, 로얄로더 글로벌 대장주인 경우 우선 배정
        for idx, s in enumerate(stock_details):
            if s["is_global_leader"]:
                s["role"] = "👑 대장주 (로얄)"
            elif idx == 0:
                s["role"] = "👑 대장주"
            elif idx == 1:
                s["role"] = "🥇 1등주"
            elif idx == 2:
                s["role"] = "🥈 2등주"
            else:
                s["role"] = "후발주"

            # 매수 가능 구간 판정 및 Slack 알림 연동
            self.trigger_slack_alerts_if_needed(s, theme_name)

        self.flush_pending_alerts()
        return stock_details

    @staticmethod
    def _is_kst_alert_window() -> bool:
        """한국시간(KST) 기준 08:00~20:00 알림 가능 시간대 여부"""
        from datetime import datetime, timedelta, timezone
        now_kst = datetime.now(timezone(timedelta(hours=9)))
        return 8 <= now_kst.hour < 20

    def trigger_slack_alerts_if_needed(self, stock_item: Dict[str, Any], theme_name: str):
        """특정 종목(대장주/1등주)의 매수 타점 진입 시 Slack 알림 대기열에 추가 (쿨다운 1시간 적용, KST 08~20시만)"""
        if not self.slack or stock_item["role"] not in ["👑 대장주", "👑 대장주 (로얄)", "🥇 1등주"]:
            return
        if not self._is_kst_alert_window():
            return

        drop = stock_item["drop"]
        code = stock_item["stock_code"]
        name = stock_item["stock_name"]

        # 종목별 라디오버튼 설정으로 수신 종목에 없는 경우 알림을 보내지 않음 (기본 안받기)
        if code not in self.pullback_alert_enabled_codes:
            return
        price_str = stock_item.get("price_str", "-")
        rate_str = stock_item.get("rate_str", "-")
        role = stock_item.get("role", "")
        buy_zone_1 = stock_item.get("buy_zone_1", "-")
        buy_zone_2 = stock_item.get("buy_zone_2", "-")

        # 1차 낙폭 (-4% ~ -8%) 매수 구간
        is_1st_drop_zone = -8.0 <= drop <= -4.4
        # 2차 낙폭 (-8% ~ -12%) 매수 구간
        is_2nd_drop_zone = -12.0 <= drop < -8.0

        current_time = time.time()
        cooldown_seconds = 3600

        if is_1st_drop_zone or is_2nd_drop_zone:
            zone_name = "1차 낙폭(-4.4~-8%)" if is_1st_drop_zone else "2차 낙폭(-8~-12%)"
            emoji = "⚡" if is_1st_drop_zone else "🟠"
            cooldown_key = f"{code}_1st_drop_zone" if is_1st_drop_zone else f"{code}_2nd_drop_zone"
            last_sent = self.slack_alert_history.get(cooldown_key, 0)
            
            if current_time - last_sent > cooldown_seconds:
                # 알림 대기열(배치용)에 수집
                self.pending_alerts.append({
                    "code": code,
                    "name": name,
                    "role": role,
                    "theme_name": theme_name,
                    "price_str": price_str,
                    "rate_str": rate_str,
                    "drop": drop,
                    "buy_zone_1": buy_zone_1,
                    "buy_zone_2": buy_zone_2,
                    "is_1st": is_1st_drop_zone,
                    "zone_name": zone_name,
                    "emoji": emoji,
                    "cooldown_key": cooldown_key,
                    "current_time": current_time
                })
                # 트리거 시점에 즉시 쿨다운 기록 -> 같은 사이클/경로에서 같은 종목·구간 중복 큐잉 방지
                self.slack_alert_history[cooldown_key] = current_time

    def flush_pending_alerts(self):
        """대기열에 수집된 대장주 낙폭 진입 알림들을 하나의 메시지로 묶어서 슬랙으로 발송합니다."""
        if not self.slack or not self.pending_alerts:
            return
        if not self._is_kst_alert_window():
            # KST 08~20시가 아니면 쌓인 대기열을 비우고 발송하지 않음
            self.pending_alerts.clear()
            return

        from datetime import datetime
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 1. Block Kit blocks 구성
        blocks = []
        blocks.append({
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "🚨 [대장주/1등주 매수 타점 진입 알림]",
                "emoji": True
            }
        })
        blocks.append({
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"⏰ *감지 일시:* {now_str} | *실시간 대장주 낙폭 모니터링*"
                }
            ]
        })
        blocks.append({"type": "divider"})

        fallback_lines = [f"🚨 [대장주/1등주 매수 타점 진입 알림] (기준: {now_str})\n"]

        for idx, alert in enumerate(self.pending_alerts, 1):
            name = alert["name"]
            code = alert["code"]
            role = alert["role"]
            theme_name = alert["theme_name"]
            price_str = alert["price_str"]
            rate_str = alert["rate_str"]
            drop = alert["drop"]
            buy_zone_1 = alert["buy_zone_1"]
            buy_zone_2 = alert["buy_zone_2"]
            is_1st = alert["is_1st"]
            emoji = alert["emoji"]

            stock_text = (
                f"{emoji} *[{alert['zone_name']}] {name} ({code})* | {role}\n"
                f"• *소속 테마:* {theme_name}\n"
                f"• *현재가:* {price_str} ({rate_str}) | *고점 대비 낙폭:* `{drop:.2f}%`\n"
                f"• *1차 매수구간 (-4.4~-8%):* `{buy_zone_1}`" + (" 🟢 진입" if is_1st else "") + "\n"
                f"• *2차 매수구간 (-8~-12%):* `{buy_zone_2}`" + (" 🟠 진입" if not is_1st else "")
            )
            
            fallback_lines.append(f"{idx}. {emoji} {name}({code}) | {role} | {theme_name} | 낙폭: {drop:.2f}% | 1차: {buy_zone_1} | 2차: {buy_zone_2}")

            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": stock_text
                }
            })

            # 발송 이력 캐시에 시간 기록
            self.slack_alert_history[alert["cooldown_key"]] = alert["current_time"]

            if idx < len(self.pending_alerts):
                blocks.append({"type": "divider"})

        # 대기열 비우기
        self.pending_alerts.clear()

        fallback_text = "\n".join(fallback_lines)

        try:
            # 50개 블록 초과 시 방어
            if len(blocks) <= 50:
                self.send_slack("🚨 대장주 매수 타점 진입 알림", fallback_text, blocks=blocks)
            else:
                # 안전 장치: 나눠서 발송
                for chunk in [blocks[i:i + 25] for i in range(0, len(blocks), 25)]:
                    self.send_slack("🚨 대장주 매수 타점 진입 알림", fallback_text, blocks=chunk)
            logger.info("[PULLBACK ALERT] 대장주 낙폭 통합 슬랙 알림 발송 완료!")
        except Exception as e:
            logger.error(f"[PULLBACK ALERT SEND ERROR] 슬랙 통합 전송 실패: {e}")

    def get_pullback_alert_settings(self) -> Dict[str, Any]:
        """대장주 낙폭 알람 수신 종목 코드 조회"""
        return {
            "enabled_codes": sorted(self.pullback_alert_enabled_codes)
        }

    def set_pullback_alert_settings(self, enabled_codes: List[str]) -> Dict[str, Any]:
        """대장주 낙폭 알람 수신 종목 코드 저장"""
        self.pullback_alert_enabled_codes = set(enabled_codes or [])
        return self.get_pullback_alert_settings()

    def check_and_alert_theme_leaders_pullback(self):
        """백그라운드 실시간 모니터링: 테마별 대장주가 1차 낙폭(-4.4~-8%) 구간에 진입했는지 주기적으로 점검하고 알림 발송"""
        try:
            logger.info("[PULLBACK MONITOR] 테마 대장주 1차 낙폭(-4.4~-8%) 진입 감지 스케줄러 실행 중...")
            # 캐싱 TTL이나 갱신 주기에 따라 시세 데이터를 수집하며 각 종목의 낙폭 알림(trigger_slack_alerts_if_needed) 자동 가동
            self._calculate_themes_summary()
            logger.info("[PULLBACK MONITOR] 테마 대장주 실시간 낙폭 감지 완료.")
        except Exception as e:
            logger.error(f"[PULLBACK MONITOR ERROR] 대장주 실시간 낙폭 감지 실패: {e}")

    def send_slack(self, title: str, text: str, blocks: Optional[List[Dict[str, Any]]] = None):
        if not self.slack:
            return
        try:
            kwargs = {
                "channel": SlackClient.FINANCE_CHNNAEL,
                "text": f"*{title}*\n{text}" if not blocks else text
            }
            if blocks:
                kwargs["blocks"] = blocks
            self.slack.get_client.chat_postMessage(**kwargs)
        except Exception as e:
            logger.error(f"Slack 발송 실패: {e}")

    def fetch_stock_chart_data(self, stock_code: str) -> Dict[str, Any]:
        """특정 종목의 당일 주가 변동 차트 데이터 조회 (5분 주기, 야후 파이낸스 연동)"""
        import time
        import requests
        code = stock_code.strip()
        if len(code) == 6 and code.isdigit():
            suffixes = [".KS", ".KQ"]
            for suffix in suffixes:
                symbol = f"{code}{suffix}"
                url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=1d"
                try:
                    r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=3.0)
                    if r.status_code == 200:
                        chart_res = r.json()
                        result = chart_res.get("chart", {}).get("result")
                        if result and result[0].get("timestamp"):
                            res_data = result[0]
                            meta = res_data.get("meta", {})
                            timestamps = res_data.get("timestamp", [])
                            quote = res_data.get("indicators", {}).get("quote", [{}])[0]
                            closes = quote.get("close", [])
                            highs = [h for h in quote.get("high", []) if h]
                            
                            points = []
                            for t, c in zip(timestamps, closes):
                                if c is not None:
                                    # KST 시간 변환 (KST = UTC + 9시간)
                                    # 로컬 시간대 기준 포맷팅
                                    local_time = time.localtime(t)
                                    points.append({
                                        "time": time.strftime("%H:%M", local_time),
                                        "price": round(c, 2)
                                    })
                            
                            if points:
                                # 당일 고점/낙폭은 차트(장중 5분봉)와 동일 소스에서 계산
                                day_high = float(meta.get("regularMarketDayHigh") or 0)
                                if not day_high:
                                    day_high = max(highs) if highs else 0
                                if not day_high:
                                    day_high = max(c for c in closes if c)
                                day_high = max(1.0, day_high)
                                current_price = float(meta.get("regularMarketPrice") or closes[-1] or 0)
                                intraday_drop = ((current_price - day_high) / day_high) * 100
                                return {
                                    "status": "success",
                                    "symbol": symbol,
                                    "companyName": meta.get("symbol", symbol),
                                    "prevClose": meta.get("previousClose", 0.0),
                                    "dayHigh": round(day_high, 2),
                                    "currentPrice": round(current_price, 2),
                                    "drop": round(intraday_drop, 2),
                                    "points": points
                                }
                except Exception as e:
                    logger.warning(f"야후 파이낸스 차트 조회 에러 ({symbol}): {e}")
                    
        return {"status": "error", "message": "차트 데이터를 가져올 수 없거나 지원하지 않는 종목코드입니다."}

    def fetch_stock_3month_stats(self, stock_code: str) -> Dict[str, Any]:
        """특정 종목의 최근 3개월 일봉 데이터를 야후 파이낸스로 조회하여 수급 구간(머리/어깨/무릎) 가격대 및 이평 정보를 반환합니다."""
        code = stock_code.strip()
        if len(code) != 6 or not code.isdigit():
            return {"status": "error", "message": "잘못된 종목코드입니다."}

        for suffix in [".KS", ".KQ"]:
            symbol = f"{code}{suffix}"
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=3mo"
            try:
                r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=4.0)
                if r.status_code != 200:
                    continue
                chart_res = r.json()
                result = chart_res.get("chart", {}).get("result")
                if not result or not result[0].get("timestamp"):
                    continue
                res_data = result[0]
                quote = res_data.get("indicators", {}).get("quote", [{}])[0]
                highs = [h for h in quote.get("high", []) if h]
                lows = [l for l in quote.get("low", []) if l]
                closes = [c for c in quote.get("close", []) if c]
                if not highs or not lows or not closes:
                    continue

                three_month_high = max(highs)
                three_month_low = min(lows)
                last_close = closes[-1]

                if three_month_high > three_month_low > 0:
                    pos_ratio = ((last_close - three_month_low) / (three_month_high - three_month_low)) * 100
                else:
                    pos_ratio = 50.0
                pos_ratio = max(0.0, min(100.0, pos_ratio))

                if pos_ratio >= 70.0:
                    price_level, price_level_desc = "머리", "고점 부근 (매수 유의)"
                elif pos_ratio >= 35.0:
                    price_level, price_level_desc = "어깨", "중간 추세 구간"
                else:
                    price_level, price_level_desc = "무릎", "저점 부근 (매수 관심)"

                ma10_above_ma20 = False
                if len(closes) >= 20:
                    ma10 = sum(closes[-10:]) / 10
                    ma20 = sum(closes[-20:]) / 20
                    ma10_above_ma20 = ma10 >= ma20
                elif len(closes) >= 10:
                    ma10 = sum(closes[-10:]) / 10
                    ma_all = sum(closes) / len(closes)
                    ma10_above_ma20 = ma10 >= ma_all

                return {
                    "status": "success",
                    "symbol": symbol,
                    "three_month_high": round(three_month_high, 2),
                    "three_month_low": round(three_month_low, 2),
                    "last_close": round(last_close, 2),
                    "price_level": price_level,
                    "price_level_desc": price_level_desc,
                    "price_position_ratio": round(pos_ratio, 1),
                    "ma10_above_ma20": ma10_above_ma20,
                }
            except Exception as e:
                logger.warning(f"야후 파이낸스 3개월 통계 조회 에러 ({symbol}): {e}")

        return {"status": "error", "message": "3개월 통계 데이터를 가져올 수 없거나 지원하지 않는 종목코드입니다."}


    def send_theme_leaders_summary_to_slack(self):
        """30분 단위 주기적 호출: 각 테마의 대장주 및 1등주 목록을 요약하여 Slack 채널에 파일(스니펫) 형태로 업로드합니다."""
        from datetime import datetime
        import tempfile
        import os
        # KST 08:00~20:00 시간대에만 슬랙 발송
        if not self._is_kst_alert_window():
            logger.info("[SLACK SUMMARY] KST 08~20시 시간대가 아니어서 브리핑 슬랙 발송을 건너뜁니다.")
            return
        logger.info("[SLACK SUMMARY] 30분 단위 테마별 대장주 및 1등주 요약 알림 준비 시작 (파일 업로드 방식)...")

        # 1. 텍스트 파일로 저장할 내용 생성
        briefing_text = self.generate_briefing_text()
        
        if not self.slack:
            logger.info(f"[SLACK SUMMARY - Slack 미연동 상태, 콘솔 출력]\n{briefing_text}")
            return

        # 2. 임시 파일 생성
        temp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
        os.makedirs(temp_dir, exist_ok=True)
        
        now = datetime.now()
        file_name = f"theme_briefing_{now.strftime('%Y%m%d_%H%M%S')}.txt"
        file_path = os.path.join(temp_dir, file_name)
        
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(briefing_text)
                
            # 3. 슬랙 파일 업로드 전송
            # sned_message_with_file 내부적으로 files_upload_v2를 사용하여 슬랙 채널에 업로드하며, 
            # 슬랙 UI 상에서 접었다 펼쳐볼 수 있는 스니펫 형태와 다운로드 기능을 동시에 지원하게 됩니다.
            title = f"📊 실시간 테마 & 대장주 고점 대비 낙폭 브리핑 ({now.strftime('%Y-%m-%d %H:%M')})"
            comment = f"실시간 거래대금 상위 TOP 15 테마군 및 대장주/1등주 고점 대비 낙폭 브리핑 파일입니다. (정각/30분 발송)"
            
            self.slack.sned_message_with_file(
                title=title,
                comment=comment,
                file_path=file_path,
                channel=SlackClient.FINANCE_CHNNAEL
            )
            logger.info("[SLACK SUMMARY] 테마별 대장주 및 1등주 요약 파일 슬랙 전송 완료!")
        except Exception as e:
            logger.error(f"[SLACK SUMMARY ERROR] 슬랙 파일 전송 실패: {e}")
        finally:
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except Exception as ex:
                    logger.warning(f"임시 파일 삭제 실패: {ex}")

    def generate_briefing_text(self) -> str:
        """실시간 테마별 대장주 & 1등주 당일 고점 대비 낙폭 현황 (거래대금 TOP 15) 브리핑 텍스트를 생성합니다."""
        from datetime import datetime
        
        summary_res = self.get_naver_themes_summary()
        if isinstance(summary_res, dict) and summary_res.get("status") == "loading":
            summary_res = self._calculate_themes_summary()

        themes = summary_res.get("themes", []) if isinstance(summary_res, dict) else []
        if not themes:
            return "조회된 테마 데이터가 없습니다."

        # 상위 15개 테마 대상 (거래대금 기준 내림차순 정렬)
        sorted_themes = sorted(themes, key=lambda x: x.get("total_volume", 0), reverse=True)[:15]

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        lines = [
            f"⏰ [실시간 테마별 대장주 & 1등주 고점 대비 낙폭 브리핑 (거래대금 TOP 15)]",
            f"기준 일시: {now_str}",
            "💡 핵심 포커스: 당일 장중 고점 대비 하락한 가격(원) 및 낙폭률(%) 위주 정리 (눌림목 타점 체크)",
            "────────────────────────────────────────────────"
        ]

        for idx, theme in enumerate(sorted_themes, 1):
            theme_name = theme.get("theme_name", "알 수 없는 테마")
            avg_rate = theme.get("avg_rate", 0.0)
            try:
                avg_rate_val = float(avg_rate)
            except (ValueError, TypeError):
                avg_rate_val = 0.0
            vol_str = theme.get("total_volume_str", "0억 원")

            top_stocks = theme.get("top_stocks", [])
            sorted_stocks = sort_stocks_composite(top_stocks)
            leaders_info = []

            for s_idx, s in enumerate(sorted_stocks[:2]):
                role = s.get("role", "")
                if "대장주" not in role and "1등주" not in role:
                    role = "👑 대장주" if s_idx == 0 else "🥇 1등주"
                s_name = s.get("stock_name", "N/A")
                s_rate = s.get("rate_str", "0.0%")
                s_price = s.get("price_str", "-")
                s_vol = s.get("volume_str", "-")
                
                try:
                    price_val = int(s.get("price", 0))
                except (ValueError, TypeError):
                    price_val = 0

                try:
                    day_high_val = int(s.get("day_high", 0))
                except (ValueError, TypeError):
                    day_high_val = 0

                try:
                    drop_val = float(s.get("drop", 0.0))
                except (ValueError, TypeError):
                    drop_val = 0.0

                drop_str = s.get("drop_str", f"{drop_val:.2f}%")

                # 당일 고점 값이 없거나 현재가보다 낮은 경우 복구 처리 (예: 더미 데이터 등)
                if not day_high_val or day_high_val < price_val:
                    if drop_val < 0 and price_val > 0:
                        day_high_val = int(price_val / (1 + (drop_val / 100.0)))
                    else:
                        day_high_val = price_val

                diff_won = int(day_high_val) - int(price_val)
                if diff_won < 0:
                    diff_won = 0

                # 고점 대비 하락 가격 및 낙폭률 문자열 구성
                if diff_won == 0 or drop_val == 0.0:
                    drop_desc = f"🚀 당일 고점 대비: 0.00% (당일 장중 고점(최고가) 돌파/유지 중 ──▶ 현재가: {s_price})"
                else:
                    drop_desc = f"📉 당일 고점 대비: {drop_str} (당일 고점 {int(day_high_val):,}원 대비 -{diff_won:,}원 하락 ──▶ 현재가: {s_price})"

                # 1차/2차 매수 구간 및 진입 여부 안내
                buy_zone_1 = s.get("buy_zone_1", "-")
                buy_zone_2 = s.get("buy_zone_2", "-")
                if -8.0 <= drop_val <= -4.4:
                    zone_desc = f"⚡ [1차 낙폭 매수구간 진입!] 1차 매수 밴드(-4.4~-8%): {buy_zone_1}"
                elif -12.0 <= drop_val < -8.0:
                    zone_desc = f"🟠 [2차 낙폭 매수구간 진입!] 2차 매수 밴드(-8~-12%): {buy_zone_2}"
                elif drop_val < -12.0:
                    zone_desc = f"🛑 [2차 매수구간 하향 이탈] 2차 매수 밴드(-8~-12%): {buy_zone_2}"
                else:
                    zone_desc = f"🎯 [1차 낙폭 대기 중] 1차 매수 밴드(-4.4~-8%): {buy_zone_1}"

                leaders_info.append(f"  • {role}: {s_name} (거래대금: {s_vol} | 당일 등락률: {s_rate})")
                leaders_info.append(f"    └ {drop_desc}")
                leaders_info.append(f"    └ {zone_desc}")
                if s_idx == 0 and len(sorted_stocks[:2]) > 1:
                    leaders_info.append("")

            theme_header = f"{idx}. {theme_name} (평균등락률: {avg_rate_val:+.2f}% | 총거래대금: {vol_str})"
            lines.append(theme_header)
            if leaders_info:
                lines.extend(leaders_info)
            else:
                lines.append("  • 표시할 소속 종목 정보 없음")
            lines.append("────────────────────────────────────────────────")

        return "\n".join(lines)

    def get_stock_network(self, stock_name_or_code: str) -> Dict[str, Any]:
        return {"status": "error", "message": "Deprecated"}
        # Deprecated logic removed

    def get_dummy_themes_data(self) -> Dict[str, Any]:
        import random
        if not hasattr(self, "dummy_prices"):
            self.dummy_prices = {
                "000660": 185000,
                "005930": 75800,
                "080220": 24500
            }
        else:
            for code in self.dummy_prices:
                change = random.choice([-1, 0, 1]) * random.randint(100, 500)
                self.dummy_prices[code] = max(1000, self.dummy_prices[code] + change)

        p_hynix = self.dummy_prices["000660"]
        p_samsung = self.dummy_prices["005930"]
        p_jeju = self.dummy_prices["080220"]

        dummy_data = [
            {
                "theme_name": "S7(삼성전자/SK하이닉스 등)",
                "avg_rate": 5.82,
                "total_volume": 12450000000000,
                "total_volume_str": "12조 4,500억 원",
                "mapped_count": 5,
                "total_count": 5,
                "leader_stock": "SK하이닉스",
                "top_stocks": [
                    {
                        "stock_code": "000660",
                        "stock_name": "SK하이닉스",
                        "description": "반도체 대장주",
                        "rate": 8.45,
                        "rate_str": "+8.45%",
                        "price": p_hynix,
                        "price_str": f"{p_hynix:,}원",
                        "volume": 6500000000000,
                        "volume_shares": 35135135,
                        "three_month_high": 210000,
                        "three_month_high_str": "210,000원",
                        "avg_volume": 25000000,
                        "avg_volume_str": "25,000,000주",
                        "volume_ratio": 140.54,
                        "volume_ratio_str": "140.5%",
                        "ma10_above_ma20": True,
                        "role": "👑 대장주",
                        "volume_str": "6조 5,000억",
                        "drop": -11.90,
                        "drop_str": "-11.90%",
                        "buy_zone_1": "173,900 ~ 177,600원",
                        "buy_zone_2": "166,500 ~ 173,900원"
                    },
                    {
                        "stock_code": "005930",
                        "stock_name": "삼성전자",
                        "description": "메모리 반도체 1위",
                        "rate": 4.12,
                        "rate_str": "+4.12%",
                        "price": p_samsung,
                        "price_str": f"{p_samsung:,}원",
                        "volume": 4200000000000,
                        "volume_shares": 55408970,
                        "three_month_high": 88000,
                        "three_month_high_str": "88,000원",
                        "ma10_above_ma20": False,
                        "avg_volume": 45000000,
                        "avg_volume_str": "45,000,000주",
                        "volume_ratio": 123.13,
                        "volume_ratio_str": "123.1%",
                        "role": "🥇 1등주",
                        "volume_str": "4조 2,000억",
                        "drop": -13.86,
                        "drop_str": "-13.86%",
                        "buy_zone_1": "71,200 ~ 72,700원",
                        "buy_zone_2": "68,200 ~ 71,200원"
                    }
                ],
                "volume_share": 35.4,
                "rate_rank": 1,
                "vol_rank": 1,
                "composite_rank": 1
            },
            {
                "theme_name": "온디바이스 AI",
                "avg_rate": 3.75,
                "total_volume": 4200000000000,
                "total_volume_str": "4조 2,000억 원",
                "mapped_count": 3,
                "total_count": 3,
                "leader_stock": "제주반도체",
                "top_stocks": [
                    {
                        "stock_code": "080220",
                        "stock_name": "제주반도체",
                        "description": "모바일/저전력 반도체 설계 전문",
                        "rate": 12.50,
                        "rate_str": "+12.50%",
                        "price": p_jeju,
                        "price_str": f"{p_jeju:,}원",
                        "volume": 2500000000000,
                        "volume_shares": 102040816,
                        "three_month_high": 32000,
                        "three_month_high_str": "32,000원",
                        "ma10_above_ma20": True,
                        "avg_volume": 85000000,
                        "avg_volume_str": "85,000,000주",
                        "volume_ratio": 120.05,
                        "volume_ratio_str": "120.1%",
                        "role": "👑 대장주",
                        "volume_str": "2조 5,000억",
                        "drop": -23.44,
                        "drop_str": "-23.44%",
                        "buy_zone_1": "23,000 ~ 23,500원",
                        "buy_zone_2": "22,000 ~ 23,000원"
                    }
                ],
                "volume_share": 12.0,
                "rate_rank": 2,
                "vol_rank": 2,
                "composite_rank": 2
            }
        ]
        
        dummy_indices = {
            "kospi": {
                "price": "2,652.12",
                "price_str": "2,652.12",
                "rate_str": "+1.24%"
            },
            "nasdaq_futures": {
                "price": "19,250.50",
                "price_str": "19,250.50",
                "rate_str": "+0.85%"
            },
            "philadelphia_semiconductor": {
                "price": "4,950.20",
                "price_str": "4,950.20",
                "rate_str": "+2.15%"
            }
        }
        
        dummy_news = [
            {"title": "[특징주] SK하이닉스, 실시간 외국인 대규모 매수세에 급등세", "source": "뉴스원", "url": "https://naver.com", "time_str": "5분 전"},
            {"title": "[특징주] 제주반도체, 온디바이스 AI 시장 개화로 수급 대거 유입", "source": "이데일리", "url": "https://naver.com", "time_str": "12분 전"},
            {"title": "반도체 지수 폭발, 대형 보통주 중심 강력한 수급 확인", "source": "한국경제", "url": "https://naver.com", "time_str": "20분 전"}
        ]
        
        # 로얄로더 더미 테마 데이터 복사 및 프리픽스 변경
        for d in dummy_data:
            d["source"] = "naver"
            d["up_count"] = sum(1 for s in d.get("top_stocks", []) if s.get("rate", 0) > 0)
            d["down_count"] = sum(1 for s in d.get("top_stocks", []) if s.get("rate", 0) < 0)
            d["flat_count"] = sum(1 for s in d.get("top_stocks", []) if s.get("rate", 0) == 0)

        dummy_royal_data = []
        for d in dummy_data:
            rd = d.copy()
            if "온디바이스 AI" in d["theme_name"]:
                rd["theme_name"] = "온디바이스 AI"
            else:
                rd["theme_name"] = "👑 로얄 - " + d["theme_name"].replace("S7", "반도체 대장")
            rd["source"] = "royal"
            rd["up_count"] = sum(1 for s in rd.get("top_stocks", []) if s.get("rate", 0) > 0)
            rd["down_count"] = sum(1 for s in rd.get("top_stocks", []) if s.get("rate", 0) < 0)
            rd["flat_count"] = sum(1 for s in rd.get("top_stocks", []) if s.get("rate", 0) == 0)
            dummy_royal_data.append(rd)

        # Merge dummy themes using same logic as production
        merged_dummy_map = {}
        for nt in dummy_data:
            name = nt["theme_name"]
            merged_dummy_map[name] = nt.copy()

        for rt in dummy_royal_data:
            name = rt["theme_name"]
            if name in merged_dummy_map:
                existing = merged_dummy_map[name]
                existing["source"] = "both"
                # Combine stocks and deduplicate by stock_code
                stock_dict = {}
                for s in existing["top_stocks"]:
                    stock_dict[s["stock_code"]] = s
                    
                for s in rt["top_stocks"]:
                    code = s["stock_code"]
                    if code in stock_dict:
                        existing_stock = stock_dict[code]
                        if not existing_stock.get("description") and s.get("description"):
                            existing_stock["description"] = s["description"]
                        if "대장주" in s.get("role", "") or "1등주" in s.get("role", ""):
                            existing_stock["role"] = s["role"]
                    else:
                        stock_dict[code] = s
                
                merged_stocks = sorted(stock_dict.values(), key=lambda x: x.get('rate', 0), reverse=True)
                existing["top_stocks"] = merged_stocks[:5]
                
                unique_stocks = list(stock_dict.values())
                existing["mapped_count"] = len(unique_stocks)
                
                total_rate = sum(s.get("rate", 0) for s in unique_stocks)
                existing["avg_rate"] = round(total_rate / len(unique_stocks), 2) if unique_stocks else 0.0
                
                existing["up_count"] = sum(1 for s in unique_stocks if s.get("rate", 0) > 0)
                existing["down_count"] = sum(1 for s in unique_stocks if s.get("rate", 0) < 0)
                existing["flat_count"] = sum(1 for s in unique_stocks if s.get("rate", 0) == 0)
            else:
                merged_dummy_map[name] = rt

        combined_dummy = list(merged_dummy_map.values())
        combined_dummy = sorted(combined_dummy, key=lambda x: x['total_volume'], reverse=True)

        return {
            "themes": combined_dummy,
            "top_themes_5": combined_dummy[:5],
            "indices": dummy_indices,
            "recent_news": dummy_news,
            "leader_sectors_3": combined_dummy[:3],
            "royal_themes": []
        }

    def fetch_naver_breaking_news(self) -> List[Dict[str, Any]]:
        """
        네이버 증권 실시간 시황 속보 뉴스(LSS3D, 101/258/401)를 크롤링하여 최신 5개 뉴스를 반환합니다.
        """
        import requests
        from bs4 import BeautifulSoup
        from urllib.parse import urlparse, parse_qs

        url = "https://finance.naver.com/news/news_list.naver?mode=LSS3D&section_id=101&section_id2=258&section_id3=401"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

        def reformat_naver_link(href: str) -> str:
            try:
                parsed_url = urlparse(href)
                query_params = parse_qs(parsed_url.query)
                article_id_list = query_params.get("article_id")
                office_id_list = query_params.get("office_id")
                if article_id_list and office_id_list:
                    return f"https://n.news.naver.com/mnews/article/{office_id_list[0]}/{article_id_list[0]}"
            except Exception:
                pass
            if href.startswith("/"):
                return f"https://finance.naver.com{href}"
            return href

        news_data = []
        try:
            res = requests.get(url, headers=headers, timeout=5)
            if res.status_code != 200:
                return []

            # EUC-KR 디코딩 처리
            soup = BeautifulSoup(res.content, "html.parser", from_encoding="euc-kr")

            # 1. 다양한 셀렉터 시도 (시황/전망 속보는 dl.newsList 혹은 ul.new_list 형식을 가집니다)
            news_items = soup.select("dl.newsList dd, dl.newsList dt, .newsList li, .realtimeNewsList li, div.newsList_area li")

            # 2. 범용적인 a 태그 직접 서치 fallback (구조가 틀어지거나 완전히 다를 경우)
            if not news_items:
                a_tags = []
                for a in soup.find_all("a"):
                    href = a.get("href", "")
                    if "news_read.naver" in href and a.text.strip():
                        a_tags.append(a)

                for a_tag in a_tags:
                    if len(news_data) >= 5:
                        break
                    title = a_tag.text.strip()
                    href = a_tag.get("href", "")
                    link = reformat_naver_link(href)

                    if any(x["url"] == link for x in news_data):
                        continue

                    # 언론사명과 시간은 부모 노드 상향 서치
                    press = "네이버금융"
                    time_str = "방금 전"

                    parent = a_tag.parent
                    for _ in range(3):
                        if not parent:
                            break
                        press_el = parent.select_one(".press, .source")
                        if press_el:
                            press = press_el.text.strip()
                        wdate_el = parent.select_one(".wdate, .date")
                        if wdate_el:
                            raw_date = wdate_el.text.strip()
                            time_str = raw_date[11:16] if len(raw_date) >= 16 else raw_date
                        if press_el or wdate_el:
                            break
                        parent = parent.parent

                    news_data.append({
                        "id": len(news_data) + 1,
                        "title": title,
                        "source": press,
                        "time_str": time_str,
                        "url": link
                    })
                return news_data

            # 3. 셀렉터 매칭 성공 시 정상 파싱
            for item in news_items:
                if len(news_data) >= 5:
                    break

                a_tag = item.select_one("a")
                if not a_tag:
                    continue

                title = a_tag.text.strip()
                href = a_tag.get("href", "")
                if not href or not title:
                    continue

                link = reformat_naver_link(href)

                # 중복 뉴스 방지
                if any(x["url"] == link for x in news_data):
                    continue

                # 언론사와 시간 정보 추출
                summary_dd = item.find_next_sibling("dd") if item.name == "dt" else item
                press = "네이버금융"
                time_str = "방금 전"

                if summary_dd:
                    press_span = summary_dd.select_one("span.press")
                    if press_span:
                        press = press_span.text.strip()
                    wdate_span = summary_dd.select_one("span.wdate")
                    if wdate_span:
                        raw_date = wdate_span.text.strip()
                        if len(raw_date) >= 16:
                            time_str = raw_date[11:16] # 시:분만 추출
                        else:
                            time_str = raw_date

                news_data.append({
                    "id": len(news_data) + 1,
                    "title": title,
                    "source": press,
                    "time_str": time_str,
                    "url": link
                })
        except Exception as e:
            logger.error(f"네이버 속보 뉴스 크롤링 중 오류: {e}")

        return news_data
