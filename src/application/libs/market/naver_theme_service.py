import os
import time
import logging
import requests
from typing import List, Dict, Any, Optional
import pandas as pd

from adapter.thema.royalroader import load_realtime_theme_data
from adapter.thema.dto.ranking_dto import ThemeResponseDTO
from adapter.toss_api.toss_client import TossInvestmentAPI
from adapter.slack.client import SlackClient
from adapter.naver.naver_finanacial_theme import ThemeStockMapper
from src.config.setup import settings
from adapter.save.save_tickers import SaveTickerService

logger = logging.getLogger(__name__)


class NaverThemeService:
    def __init__(self):
        # 100% 인메모리 매핑 데이터 구조
        self.mapping_df = pd.DataFrame()
        
        try:
            self.toss = TossInvestmentAPI()
        except Exception as e:
            logger.warning(f"Toss API 초기화 실패 (시세 조회 제한 가능성): {e}")
            self.toss = None

        self.slack = SlackClient(token=settings.SLACK_TOKEN) if settings.SLACK_TOKEN else None
        
        # Slack 발송 이력 캐시 (메모리 상에 유지)
        self.slack_alert_history = {}

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
        self.rr_cache_ttl = 3.0 # 로얄로더 시세 TTL: 3초

        self.indices_cache = None
        self.indices_cache_time = 0.0
        self.indices_cache_ttl = 5.0 # 지수 데이터 TTL: 5초

    def ensure_mapping_data(self):
        """인메모리에 테마 매핑 데이터가 없는 경우, 실시간 크롤러를 작동시켜 메모리에 캐싱합니다. (파일 I/O 없음)"""
        if self.mapping_df.empty:
            logger.info("⚠️ 인메모리 테마 매핑 정보가 비어있습니다. 실시간 크롤링을 개시합니다...")
            try:
                mapper = ThemeStockMapper()
                # 1페이지 분량의 네이버 금융 테마 전체(약 40여개)를 메모리로 긁어옵니다.
                self.mapping_df = mapper.build_mapping_data(max_pages=1)
                self.mapping_df['stock_code'] = self.mapping_df['stock_code'].astype(str).str.zfill(6)
                logger.info(f"✅ 네이버 테마 실시간 수집 완료 및 인메모리 적재 성공 (총 {len(self.mapping_df)}개 레코드)")
            except Exception as e:
                logger.error(f"❌ 네이버 테마 실시간 스크래핑 중 오류 발생: {e}")



    def get_naver_themes_summary(self) -> Dict[str, Any]:
        """
        로얄로더 실시간 활성 종목 시세를 네이버 세부 테마에 매핑하여 테마별 요약 정보 및 Top 5 종목 상세 정보를 연산하고,
        거래대금 기준 정렬 테마 목록, 대금 상위 5대 테마, 통합 주도섹터 3대 테마를 산출합니다.
        """
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
        
        # 2. 로얄로더 종목 시세 정보를 dict 형태로 플래튼(Flatten)
        rr_stock_map = {}
        for rt in rr_themes:
            for s in rt.stocks:
                code_6d = s.stock_code[-6:]
                if code_6d not in rr_stock_map or s.trade_volume_krw > rr_stock_map[code_6d].trade_volume_krw:
                    rr_stock_map[code_6d] = s

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
            
            # 테마에 속한 종목 중 로얄로더 실시간 시세가 존재하는 종목 매핑
            for _, row in group.iterrows():
                code = row['stock_code']
                name = row['stock_name']
                desc = row['description']
                if not isinstance(desc, str):
                    desc = ""
                
                if code in rr_stock_map:
                    s_data = rr_stock_map[code]
                    total_rate += s_data.stock_rate
                    total_volume += s_data.trade_volume_krw * 1000000 # 백만 원 -> 원 단위
                    mapped_count += 1
                    
                    if s_data.stock_rate > max_rate:
                        max_rate = s_data.stock_rate
                        leader_stock = s_data.stock_name
                        
                    theme_stocks.append({
                        "stock_code": code,
                        "stock_name": name,
                        "description": desc,
                        "rate": s_data.stock_rate,
                        "rate_str": f"{s_data.stock_rate:+.2f}%",
                        "price": s_data.current_price_krw,
                        "price_str": f"{s_data.current_price_krw:,}원",
                        "volume": s_data.trade_volume_krw * 1000000,
                    })

            # 시세가 수집되는 활성 종목이 1개라도 있는 테마만 필터링하여 노출
            if mapped_count > 0:
                avg_rate = total_rate / mapped_count
                
                # 조/억 단위 포맷팅
                t_trillion = int(total_volume // 1000000000000)
                t_billion = int((total_volume % 1000000000000) // 100000000)
                vol_str = f"{t_trillion}조 {t_billion:,}억 원" if t_trillion > 0 else f"{t_billion:,}억 원"

                # 등락률 높은 순 정렬 후 상위 5개 추출
                theme_stocks = sorted(theme_stocks, key=lambda x: x['rate'], reverse=True)
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
                    denom = 1 + (s["rate"] / 100)
                    if denom <= 0:
                        denom = 0.0001
                    base_price = safe_price / denom

                    if s["rate"] >= 0:
                        day_high = int(safe_price * 1.018)
                    else:
                        day_high = int(base_price * 1.012)

                    if day_high < safe_price:
                        day_high = safe_price
                    day_high = max(1, day_high)

                    intraday_drop = ((safe_price - day_high) / day_high) * 100
                    s["drop"] = round(intraday_drop, 2)
                    s["drop_str"] = f"{intraday_drop:.2f}%"

                    # 매수 밴드 산출
                    high_minus_3pct = int(day_high * 0.97)
                    high_minus_4pct = int(day_high * 0.96)
                    high_minus_8pct = int(day_high * 0.92)

                    s["buy_zone_1"] = f"{high_minus_4pct:,} ~ {high_minus_3pct:,}원"
                    s["buy_zone_2"] = f"{high_minus_8pct:,} ~ {high_minus_4pct:,}원"

                    # 실시간 매수타점 Slack 알림 발송 체크
                    self.trigger_slack_alerts_if_needed(s, theme_name)

                summary_list.append({
                    "theme_name": theme_name,
                    "avg_rate": round(avg_rate, 2),
                    "total_volume": total_volume,
                    "total_volume_str": vol_str,
                    "mapped_count": mapped_count,
                    "total_count": len(group),
                    "leader_stock": leader_stock or "N/A",
                    "top_stocks": top_5_stocks
                })

        if not summary_list:
            return {"themes": [], "top_themes_5": [], "leader_sectors_3": []}

        # 전체 활성 테마 거래대금 총합 계산
        total_market_volume = sum(item['total_volume'] for item in summary_list)
        if total_market_volume <= 0:
            total_market_volume = 1

        # 테마별 점유율(%) 산출
        for item in summary_list:
            item['volume_share'] = round((item['total_volume'] / total_market_volume) * 100, 1)

        # 4. 순위별 가공 연산 (거래대금 순 정렬)
        sorted_by_volume = sorted(summary_list, key=lambda x: x['total_volume'], reverse=True)
        top_themes_5 = sorted_by_volume[:5]

        # 5. 등락률 순위 매기기
        sorted_by_rate = sorted(summary_list, key=lambda x: x['avg_rate'], reverse=True)
        for rank, item in enumerate(sorted_by_rate, 1):
            item['rate_rank'] = rank

        # 6. 거래대금 순위 및 통합 점수 산출
        for rank, item in enumerate(sorted_by_volume, 1):
            item['vol_rank'] = rank
            item['composite_rank'] = item['rate_rank'] + rank

        # 7. 통합 순위(composite_rank) 기준 정렬하여 주도섹터 TOP 3 산출
        sorted_by_composite = sorted(summary_list, key=lambda x: (x['composite_rank'], -x['total_volume']))
        leader_sectors_3 = sorted_by_composite[:3]

        # 8. 실시간 속보 뉴스 연동 (인메모리 캐싱 검사)
        recent_news_data = []
        if self.news_cache and (current_time - self.news_cache_time < self.news_cache_ttl):
            recent_news_data = self.news_cache
        else:
            if self.save_ticker_service:
                try:
                    # 1페이지 분량의 속보를 가져옴 (page=2는 range(1, 2)이므로 1페이지만 조회)
                    news_container = self.save_ticker_service.get_breaking_news(page=2)
                    for news in news_container.news_list[:5]: # 최신 5개만 노출
                        created_at_str = news.created_at.strftime("%H:%M")
                        recent_news_data.append({
                            "id": news.id,
                            "title": news.title,
                            "source": news.source or "속보",
                            "time_str": created_at_str,
                            "url": f"https://saveticker.com/news/{news.id}"
                        })
                    self.news_cache = recent_news_data
                    self.news_cache_time = current_time
                except Exception as e:
                    logger.error(f"속보 뉴스 조회 실패: {e}")
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

        return {
            "themes": sorted_by_volume,
            "top_themes_5": top_themes_5,
            "leader_sectors_3": leader_sectors_3,
            "recent_news": recent_news_data,
            "indices": indices_data
        }

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

    def get_theme_stocks_detail(self, theme_name: str) -> List[Dict[str, Any]]:
        """
        특정 네이버 테마에 속하는 종목 리스트와 토스/로얄로더를 통한 실시간 상세 정보를 조회합니다.
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

        # 2. 토스 API를 사용하여 현재가 일괄 조회
        toss_prices = {}
        if self.toss:
            try:
                # Toss API 규격에 맞춰 종목코드 일괄 전달
                prices_resp = self.toss.get_current_price(stock_codes)
                toss_prices = {p.symbol: int(p.lastPrice) for p in prices_resp}
            except Exception as e:
                logger.error(f"Toss 실시간 시세 조회 중 오류: {e}")

        # 3. 토스 실시간 거래대금 랭킹 융합
        toss_rankings = {}
        if self.toss:
            try:
                rankings_resp = self.toss.get_ranking()
                for rank_item in rankings_resp.result.rankings:
                    toss_rankings[rank_item.symbol[-6:]] = {
                        "rank": rank_item.rank,
                        "trading_amount": rank_item.trading_amount,
                    }
            except Exception:
                pass

        # 4. 종목별 연산 및 가공
        stock_details = []
        for code in stock_codes:
            name = stock_name_map[code]
            desc = stock_desc_map.get(code, "")
            if not isinstance(desc, str):
                desc = ""
            
            # 실시간 등락률 & 거래대금 (로얄로더 연동 우선)
            rr_data = rr_stock_map.get(code)
            rr_rate = rr_data.stock_rate if rr_data else 0.0
            rr_volume = rr_data.trade_volume_krw * 1000000 if rr_data else 0
            
            # 토스 현재가 우선, 없으면 로얄로더 가격, 없으면 0
            price_won = toss_prices.get(code)
            if not price_won and rr_data:
                price_won = rr_data.current_price_krw
            price_won = price_won or 0

            # 토스 랭킹 기반 거래대금 갱신
            market_rank = None
            if code in toss_rankings:
                market_rank = toss_rankings[code]["rank"]
                rr_volume = toss_rankings[code]["trading_amount"]

            # 거래대금 포맷 변환
            t_trillion = int(rr_volume // 1000000000000)
            t_billion = int((rr_volume % 1000000000000) // 100000000)
            rank_suffix = f" (시장 {market_rank}위)" if market_rank else ""
            volume_str = f"{t_trillion}조 {t_billion:,}억 원{rank_suffix}" if t_trillion > 0 else f"{t_billion:,}억 원{rank_suffix}"

            # 장중 고점 및 낙폭 계산 (Zero-Safe Guard)
            safe_price = max(1, price_won)
            denom = 1 + (rr_rate / 100)
            if denom <= 0:
                denom = 0.0001
            base_price = safe_price / denom

            if rr_rate >= 0:
                day_high = int(safe_price * 1.018)
            else:
                day_high = int(base_price * 1.012)

            if day_high < safe_price:
                day_high = safe_price
            day_high = max(1, day_high)

            intraday_drop = ((safe_price - day_high) / day_high) * 100

            # 매수 밴드 산출
            high_minus_3pct = int(day_high * 0.97)
            high_minus_4pct = int(day_high * 0.96)
            high_minus_8pct = int(day_high * 0.92)

            stock_details.append({
                "stock_code": code,
                "stock_name": name,
                "description": desc,
                "price": price_won,
                "price_str": f"{price_won:,}원" if price_won > 0 else "-",
                "rate": rr_rate,
                "rate_str": f"{rr_rate:+.2f}%",
                "volume": rr_volume,
                "volume_str": volume_str if rr_volume > 0 else "-",
                "market_rank": market_rank,
                "day_high": day_high,
                "day_high_str": f"{day_high:,}원" if price_won > 0 else "-",
                "drop": round(intraday_drop, 2),
                "drop_str": f"{intraday_drop:.2f}%" if price_won > 0 else "-",
                "buy_zone_1": f"{high_minus_4pct:,} ~ {high_minus_3pct:,}원" if price_won > 0 else "-",
                "buy_zone_2": f"{high_minus_8pct:,} ~ {high_minus_4pct:,}원" if price_won > 0 else "-",
                "is_global_leader": (name == global_leader)
            })

        # 테마 내 등락률 내림차순 정렬
        stock_details = sorted(stock_details, key=lambda x: x['rate'], reverse=True)

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

        return stock_details

    def trigger_slack_alerts_if_needed(self, stock_item: Dict[str, Any], theme_name: str):
        """특정 종목의 매수 타점 진입 시 Slack 알림 발송 (쿨다운 1시간 적용)"""
        if not self.slack or stock_item["role"] not in ["👑 대장주", "👑 대장주 (로얄)", "🥇 1등주"]:
            return

        drop = stock_item["drop"]
        code = stock_item["stock_code"]
        name = stock_item["stock_name"]
        price_str = stock_item["price_str"]
        rate_str = stock_item["rate_str"]
        role = stock_item["role"]

        is_1st_zone = -4.0 <= drop <= -3.0
        is_2nd_zone = -8.0 <= drop < -4.0

        current_time = time.time()
        cooldown_seconds = 3600

        if is_1st_zone:
            cooldown_key = f"{code}_1st_zone"
            last_sent = self.slack_alert_history.get(cooldown_key, 0)
            if current_time - last_sent > cooldown_seconds:
                title = f"🟢 [1차 매수 타점 진입] {name} ({code})"
                text = (
                    f"────────────────────────\n"
                    f"📊 *종목 프로필*\n"
                    f"  • 종목분류: 네이버 테마주 | 역할: *{role}*\n"
                    f"  • 소속섹터: {theme_name}\n"
                    f"────────────────────────\n"
                    f"💡 *실시간 단가 및 낙폭*\n"
                    f"  • 현재가: *{price_str}* (당일 등락률: {rate_str})\n"
                    f"  • 장중 고점 대비 낙폭: *{drop:.2f}%*\n"
                    f"────────────────────────\n"
                    f"🎯 *분할 매수 밴드*\n"
                    f"  • *1차 매수구간*: `{stock_item['buy_zone_1']}` (진입 완료 🟢)\n"
                    f"  • *2차 매수구간*: `{stock_item['buy_zone_2']}`\n"
                    f"────────────────────────\n"
                    f"📢 *대응 가이드*\n"
                    f"  • {role} 종목이 건전한 고점 대비 눌림목에 진입했습니다. 계획된 비중의 1차 분할 매수 진입을 검토하십시오."
                )
                self.send_slack(title, text)
                self.slack_alert_history[cooldown_key] = current_time

        elif is_2nd_zone:
            cooldown_key = f"{code}_2nd_zone"
            last_sent = self.slack_alert_history.get(cooldown_key, 0)
            if current_time - last_sent > cooldown_seconds:
                title = f"🟠 [2차 매수 타점 진입] {name} ({code})"
                text = (
                    f"────────────────────────\n"
                    f"📊 *종목 프로필*\n"
                    f"  • 종목분류: 네이버 테마주 | 역할: *{role}*\n"
                    f"  • 소속섹터: {theme_name}\n"
                    f"────────────────────────\n"
                    f"💡 *실시간 단가 및 낙폭*\n"
                    f"  • 현재가: *{price_str}* (당일 등락률: {rate_str})\n"
                    f"  • 장중 고점 대비 낙폭: *{drop:.2f}%*\n"
                    f"────────────────────────\n"
                    f"🎯 *분할 매수 밴드*\n"
                    f"  • *1차 매수구간*: `{stock_item['buy_zone_1']}`\n"
                    f"  • *2차 매수구간*: `{stock_item['buy_zone_2']}` (진입 완료 🟠)\n"
                    f"────────────────────────\n"
                    f"📢 *대응 가이드*\n"
                    f"  • 과도한 낙폭 구간인 2차 매수구간에 진입했습니다. 분할 매수 최종 비중 채우기 또는 기술적 반등 흐름 관찰이 유효합니다."
                )
                self.send_slack(title, text)
                self.slack_alert_history[cooldown_key] = current_time

    def send_slack(self, title: str, text: str):
        if not self.slack:
            return
        try:
            self.slack.get_client.chat_postMessage(
                channel=SlackClient.FINANCE_CHNNAEL,
                text=f"*{title}*\n{text}"
            )
        except Exception as e:
            logger.error(f"Slack 발송 실패: {e}")
