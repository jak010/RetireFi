from fastapi.routing import APIRouter

from src.application.libs.market.naver_theme_service import NaverThemeService
from src.application.libs.market.news_summarizer_service import NewsSummaryService
from src.application.libs.market.market_cap_service import market_cap_service
from src.application.libs.market.news_service import NewsService
from src.application.libs.market.closing_bet_material_service import ClosingBetMaterialService

naver_theme_service = NaverThemeService()
news_service = NewsService()
closing_bet_service = ClosingBetMaterialService()

market_entrypoint = APIRouter(tags=["MARKET"], prefix="/api/v1/market")


class MarketController:

    @staticmethod
    @market_entrypoint.get(path="/naver-themes",
                           summary="[MARKET] : 네이버 테마 요약 목록 실시간 조회")
    def get_naver_themes():
        res = naver_theme_service.get_naver_themes_summary()
        if isinstance(res, dict) and res.get("status") == "loading":
            return res
        return {
            "status": "success",
            "data": res.get("themes", []),
            "top_themes_5": res.get("top_themes_5", []),
            "leader_sectors_3": res.get("leader_sectors_3", []),
            "recent_news": res.get("recent_news", []),
            "indices": res.get("indices", {}),
            "royal_themes": res.get("royal_themes", [])
        }

    @staticmethod
    @market_entrypoint.get(path="/report",
                           summary="[MARKET] : 현재 수급테마 대장주/1등주 및 종베 종목 리포트 데이터 조회")
    def get_report():
        return naver_theme_service.get_report_data()

    @staticmethod
    @market_entrypoint.get(path="/naver-themes/{theme_name}/stocks",
                           summary="[MARKET] : 특정 네이버 테마의 소속 종목 실시간 상세 조회")
    def get_naver_theme_stocks(theme_name: str):
        return {
            "status": "success",
            "data": naver_theme_service.get_theme_stocks_detail(theme_name)
        }

    @staticmethod
    @market_entrypoint.get(path="/holdings/symbols",
                           summary="[MARKET] : 보유 주식 종목코드 목록 조회")
    async def get_holdings_symbols():
        from adapter.toss_api.toss_client import TossInvestmentAPI
        import logging
        try:
            toss_api = TossInvestmentAPI()
            holdings = toss_api.get_my_asset()
            symbols = [h.symbol for h in holdings]
            return {"status": "success", "data": symbols}
        except Exception as e:
            logging.getLogger("uvicorn").error(f"Failed to fetch holding symbols: {e}")
            return {"status": "error", "data": []}

    @market_entrypoint.get(path="/stocks/{code}/news",
                           summary="[MARKET] : 종목코드 기반 네이버 증권 최근 뉴스 및 공시 목록 조회")
    async def get_stock_news(code: str):
        news_list = await news_service.get_news(code)
        notice_list = await news_service.get_disclosures(code)
        return {
            "status": "success",
            "data": {
                "news": news_list,
                "disclosures": notice_list
            }
        }

    @staticmethod
    @market_entrypoint.get(path="/holdings/news",
                           summary="[MARKET] : 보유 주식 실시간 뉴스 조회")
    async def get_holdings_news():
        from adapter.toss_api.toss_client import TossInvestmentAPI
        import asyncio
        import logging
        try:
            toss_api = TossInvestmentAPI()
            holdings = toss_api.get_my_asset()
        except Exception as e:
            logging.getLogger("uvicorn").error(f"Failed to fetch holdings for news: {e}")
            holdings = []
        
        async def fetch_for_symbol(sym, name):
            n_list = await news_service.get_news(sym)
            for n in n_list:
                n["stock_name"] = name
                n["stock_code"] = sym
            return n_list
            
        # 수익률이 -7% 이하인 종목은 제외 (h.profit_loss_rate > -0.07)
        tasks = [
            fetch_for_symbol(h.symbol, h.name) 
            for h in holdings 
            if h.market_country == "KR" and float(h.profit_loss_rate) > -0.07
        ]
        results = await asyncio.gather(*tasks)
        
        all_news = []
        for r in results:
            all_news.extend(r)
            
        # Sort by date descending (assuming date string is sortable or we just return it)
        # Naver date format is usually "YYYY.MM.DD HH:MM" or similar
        all_news.sort(key=lambda x: x.get("date", ""), reverse=True)
        
        return {
            "status": "success",
            "data": all_news[:50]  # Limit to top 50 recent news
        }

    @staticmethod
    @market_entrypoint.get(path="/cron/news-summary",
                           summary="[CRON] : 최신 마켓 속보 요약 및 슬랙 브리핑 전송 (비활성화됨)")
    def run_news_summary():
        return {
            "status": "success",
            "summary": "뉴스 요약 서비스가 수동 비활성화되었습니다."
        }


    @staticmethod
    @market_entrypoint.get(path="/pullback-alert-settings",
                           summary="[MARKET] : 대장주 낙폭 알람 수신 종목 설정 조회")
    def get_pullback_alert_settings():
        return {
            "status": "success",
            "data": naver_theme_service.get_pullback_alert_settings()
        }

    @staticmethod
    @market_entrypoint.put(path="/pullback-alert-settings",
                           summary="[MARKET] : 대장주 낙폭 알람 수신 종목 설정 저장")
    def set_pullback_alert_settings(payload: dict):
        return {
            "status": "success",
            "data": naver_theme_service.set_pullback_alert_settings(
                payload.get("enabled_codes", [])
            )
        }

    @staticmethod
    @market_entrypoint.get(path="/cron/theme-leaders-pullback-check",
                           summary="[CRON] : 테마별 대장주 1차 낙폭(-4.0~-8%) 구간 진입 체크 및 슬랙 알림")
    def run_theme_leaders_pullback_check():
        naver_theme_service.check_and_alert_theme_leaders_pullback()
        return {
            "status": "success",
            "message": "테마별 대장주 1차 낙폭 구간(-4.0~-8%) 진입 체크 완료"
        }

    @staticmethod
    @market_entrypoint.get(path="/prices",
                           summary="[MARKET] : 토스증권 실시간 현재가 조회")
    def get_realtime_prices(symbols: str):
        from adapter.toss_api.toss_client import TossInvestmentAPI
        try:
            toss_api = TossInvestmentAPI()
            symbol_list = [s.strip() for s in symbols.split(',') if s.strip()]
            if not symbol_list:
                return {"status": "success", "data": []}
                
            prices = toss_api.get_current_price(symbol_list)
            return {
                "status": "success",
                "data": [p.model_dump() for p in prices]
            }
        except Exception as e:
            import logging
            logging.getLogger("uvicorn").error(f"Failed to fetch prices: {e}")
            return {"status": "error", "message": str(e), "data": []}

    @staticmethod
    @market_entrypoint.get(path="/themes/download-briefing",
                           summary="[MARKET] : 실시간 테마 & 대장주 30분 브리핑 다운로드 (텍스트 파일)")
    def download_theme_briefing():
        from fastapi.responses import Response
        from datetime import datetime
        
        briefing_text = naver_theme_service.generate_briefing_text()
        now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"theme_briefing_{now_str}.txt"
        
        return Response(
            content=briefing_text,
            media_type="text/plain",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Content-Type": "text/plain; charset=utf-8"
            }
        )

    @staticmethod
    @market_entrypoint.get(path="/toss-ranking",
                           summary="[MARKET] : 토스증권 거래대금 상위 종목 및 테마 매핑 조회")
    def get_toss_ranking():
        # Collect mapping database first
        import os
        mapping_df = naver_theme_service.mapping_df
        stock_name_map = {}
        stock_themes_map = {}
        if not mapping_df.empty:
            for _, row in mapping_df.iterrows():
                code = row["stock_code"]
                name = row["stock_name"]
                theme = row["theme_name"]
                stock_name_map[code] = name
                if code not in stock_themes_map:
                    stock_themes_map[code] = []
                if theme not in stock_themes_map[code]:
                    stock_themes_map[code].append(theme)
        elif os.getenv("USE_DUMMY", "false").lower() == "true":
            dummy_res = naver_theme_service.get_dummy_themes_data()
            for theme in dummy_res.get("themes", []):
                theme_name = theme.get("theme_name")
                for stock in theme.get("top_stocks", []):
                    code = stock.get("stock_code")
                    name = stock.get("stock_name")
                    if code and name:
                        stock_name_map[code] = name
                        if code not in stock_themes_map:
                            stock_themes_map[code] = []
                        if theme_name not in stock_themes_map[code]:
                            stock_themes_map[code].append(theme_name)

        try:
            from adapter.toss_api.toss_client import TossInvestmentAPI
            import logging
            logger = logging.getLogger("uvicorn")
            
            toss_api = TossInvestmentAPI()
            ranking_dto = toss_api.get_ranking()
            rankings = ranking_dto.result.rankings
        except Exception as e:
            import logging
            logging.getLogger("uvicorn").warning(f"Toss API get_ranking failed, using mock fallback: {e}")
            # Mock fallback data (mapping to themes where possible)
            data = []
            mock_symbols = ["005930", "000660", "005490", "035720", "035420", "003550", "051910", "000270", "005380", "068270"]
            for idx, symbol in enumerate(mock_symbols, 1):
                name = stock_name_map.get(symbol, f"임시종목 {symbol}")
                themes = stock_themes_map.get(symbol, [])
                price = 70000 + idx * 1200
                rate = 2.45 - idx * 0.55
                amount = 2500000000000 - idx * 150000000000
                
                trillion = int(amount // 1000000000000)
                billion = int((amount % 1000000000000) // 100000000)
                amount_str = f"{trillion}조 {billion:,}억" if trillion > 0 else f"{billion:,}억"
                if trillion == 0 and billion == 0:
                    million = int((amount % 100000000) // 1000000)
                    amount_str = f"{million}백만" if million > 0 else "0억"
                
                data.append({
                    "rank": idx,
                    "symbol": symbol,
                    "name": name,
                    "themes": themes,
                    "price": price,
                    "price_str": f"{price:,}원",
                    "rate": rate,
                    "rate_str": f"{rate:+.2f}%",
                    "volume": amount,
                    "volume_str": amount_str,
                    "market_cap_str": "",
                    "toss_url": f"https://www.tossinvest.com/stocks/A{symbol}/order"
                })
            return {
                "status": "success",
                "data": data
            }

        # Resolve missing stock names via Naver Realtime API
        missing_symbols = [r.symbol for r in rankings if r.symbol not in stock_name_map]
        if missing_symbols:
            try:
                resolved = naver_theme_service.fetch_naver_realtime_prices(missing_symbols)
                for code, details in resolved.items():
                    name = details.get("name")
                    if name:
                        stock_name_map[code] = name
            except Exception as e:
                import logging
                logging.getLogger("uvicorn").error(f"Failed to resolve missing stock names: {e}")

        # Fetch market caps
        market_caps = market_cap_service.fetch_market_caps_sync([r.symbol for r in rankings])

        # Build list of enriched stocks
        data = []
        for r in rankings:
            symbol = r.symbol
            name = stock_name_map.get(symbol)
            if not name:
                name = symbol
            
            themes = stock_themes_map.get(symbol, [])
            
            price = int(r.price.last_price)
            rate = round(float(r.price.change_rate) * 100.0, 2)
            amount = int(r.trading_amount)
            
            trillion = int(amount // 1000000000000)
            billion = int((amount % 1000000000000) // 100000000)
            amount_str = f"{trillion}조 {billion:,}억" if trillion > 0 else f"{billion:,}억"
            if trillion == 0 and billion == 0:
                million = int((amount % 100000000) // 1000000)
                amount_str = f"{million}백만" if million > 0 else "0억"

            data.append({
                "rank": r.rank,
                "symbol": symbol,
                "name": name,
                "themes": themes,
                "price": price,
                "price_str": f"{price:,}원",
                "rate": rate,
                "rate_str": f"{rate:+.2f}%",
                "volume": amount,
                "volume_str": amount_str,
                "market_cap_str": market_caps.get(symbol, ""),
                "toss_url": f"https://www.tossinvest.com/stocks/A{symbol}/order"
            })
            
        return {
            "status": "success",
            "data": data
        }

    @staticmethod
    @market_entrypoint.get(path="/toss-sangtta",
                           summary="[MARKET] : 네이버, 로얄로더, 토스 통합 상따 (당일 +24% 이상 급등) 후보 종목 조회")
    def get_toss_sangtta():
        import os
        import logging
        logger = logging.getLogger("uvicorn")

        # 1. 네이버 금융 및 로얄로더에서 당일 +24% 이상 급등 후보 및 매핑 정보 획득
        candidates, stock_name_map, stock_themes_map = naver_theme_service.get_sangtta_candidates_from_naver_and_royal(min_rate=24.0)

        # 2. 토스증권 TOP_GAINERS 순위에서 당일 +24% 이상 급등 종목 통합
        try:
            from adapter.toss_api.toss_client import TossInvestmentAPI
            toss_api = TossInvestmentAPI()
            ranking_dto = toss_api.get_ranking(ranking_type="TOP_GAINERS", duration="1d", count=100)
            rankings = ranking_dto.result.rankings
            for r in rankings:
                rate_val = round(float(r.price.change_rate) * 100.0, 2)
                if rate_val >= 24.0:
                    symbol = r.symbol
                    if symbol not in candidates:
                        name = stock_name_map.get(symbol, symbol)
                        price = int(r.price.last_price)
                        amount = int(r.trading_amount)
                        candidates[symbol] = {
                            "symbol": symbol,
                            "name": name,
                            "price": price,
                            "rate": rate_val,
                            "volume": amount,
                            "sources": {"토스"},
                            "themes": stock_themes_map.get(symbol, [])
                        }
                    else:
                        candidates[symbol]["sources"].add("토스")
                        if rate_val > candidates[symbol]["rate"]:
                            candidates[symbol]["rate"] = rate_val
                        if int(r.trading_amount) > candidates[symbol]["volume"]:
                            candidates[symbol]["volume"] = int(r.trading_amount)
        except Exception as e:
            logger.warning(f"Toss API get_ranking failed during sangtta aggregation: {e}")

        # 만약 전체 수집된 종목이 없고 실패 Fallback이 필요하거나 더미 환경인 경우 목 데이터 제공
        if not candidates and os.getenv("USE_DUMMY", "false").lower() == "true":
            mock_symbols = ["011330", "148780", "239340", "0039P0", "348080"]
            mock_names = ["유니켐", "비큐AI", "이스트에이드", "매드업", "큐라티스"]
            for idx, symbol in enumerate(mock_symbols, 1):
                name = stock_name_map.get(symbol, mock_names[idx-1])
                themes = stock_themes_map.get(symbol, ["AI 챗봇", "온디바이스 AI"] if idx % 2 == 0 else ["메타버스", "로보틱스"])
                price = 5000 + idx * 1500
                rate = 29.98 if idx <= 2 else round(25.4 - idx * 0.3, 2)
                amount = 150000000000 - idx * 10000000000
                candidates[symbol] = {
                    "symbol": symbol,
                    "name": name,
                    "price": price,
                    "rate": rate,
                    "volume": amount,
                    "sources": {"네이버", "로얄로더", "토스"},
                    "themes": themes
                }

        # 누락된 종목명은 네이버 실시간 시세 API로 보완 조회
        missing_symbols = [symbol for symbol, c in candidates.items() if c["name"] == symbol or not c["name"]]
        if missing_symbols:
            try:
                resolved = naver_theme_service.fetch_naver_realtime_prices(missing_symbols)
                for code, details in resolved.items():
                    name = details.get("name")
                    if name and code in candidates:
                        candidates[code]["name"] = name
                        stock_name_map[code] = name
            except Exception as e:
                logger.error(f"Failed to resolve missing stock names for sangtta: {e}")

        # 등락률 높은 순서로 정렬
        sorted_candidates = sorted(candidates.values(), key=lambda x: x["rate"], reverse=True)

        data = []
        for idx, item in enumerate(sorted_candidates, 1):
            symbol = item["symbol"]
            name = item["name"]
            themes = item["themes"]
            price = item["price"]
            rate = item["rate"]
            amount = item["volume"]
            sources = sorted(list(item["sources"]))

            trillion = int(amount // 1000000000000)
            billion = int((amount % 1000000000000) // 100000000)
            amount_str = f"{trillion}조 {billion:,}억" if trillion > 0 else f"{billion:,}억"
            if trillion == 0 and billion == 0:
                million = int((amount % 100000000) // 1000000)
                amount_str = f"{million}백만" if million > 0 else "0억"

            data.append({
                "rank": idx,
                "symbol": symbol,
                "name": name,
                "themes": themes,
                "sources": sources,
                "price": price,
                "price_str": f"{price:,}원",
                "rate": rate,
                "rate_str": f"{rate:+.2f}%",
                "volume": amount,
                "volume_str": amount_str,
                "toss_url": f"https://www.tossinvest.com/stocks/A{symbol}/order"
            })

        return {
            "status": "success",
            "data": data
        }

    @staticmethod
    @market_entrypoint.get(path="/stocks/{stock_code}/chart",
                           summary="[MARKET] : 특정 종목의 당일 주가 변동 차트 데이터 조회")
    def get_stock_chart(stock_code: str):
        return naver_theme_service.fetch_stock_chart_data(stock_code)

    @staticmethod
    @market_entrypoint.get(path="/stocks/{stock_code}/stats-4m",
                           summary="[MARKET] : 특정 종목의 최근 3개월 수급 구간(머리/어깨/무릎) 가격대 조회 (야후 파이낸스)")
    def get_stock_4month_stats(stock_code: str):
        return naver_theme_service.fetch_stock_4month_stats(stock_code)

    @staticmethod
    @market_entrypoint.get(path="/stocks/{stock_code}/investors",
                           summary="[MARKET] : 특정 종목의 최근 수급 동향(기관/외국인) 평가 조회")
    def get_stock_investor_trend(stock_code: str):
        return naver_theme_service.fetch_investor_trend(stock_code)

    @staticmethod
    @market_entrypoint.get(path="/scanner/swing",
                           summary="[MARKET] : 스윙 후보 검색기 (시총 3조, 고점대비 -12%, 수급 3일, 정배열)")
    def scan_swing_stocks():
        return naver_theme_service.scan_swing_candidates()

    @staticmethod
    @market_entrypoint.get(path="/loading-progress",
                           summary="[MARKET] : 실시간 연산 데이터 로딩 진행률 조회")
    def get_loading_progress():
        return {
            "status": "success",
            "data": naver_theme_service.load_status
        }

    @staticmethod
    @market_entrypoint.post(path="/closing-bet/evaluate",
                            summary="[MARKET] : 종가베팅 재료 탐색 및 유효성 검증")
    async def evaluate_closing_bet_material(payload: dict):
        try:
            stock_code = payload.get("stock_code")
            user_news = payload.get("user_news_summary", "")

            # If user didn't provide news and we have a stock code, auto fetch
            if stock_code and user_news in ("없음", "", None, "파악안됨"):
                try:
                    news_list = await news_service.get_news(stock_code)
                    notice_list = await news_service.get_disclosures(stock_code)
                    
                    news_titles = [n.get("title", "") for n in news_list[:5]]
                    notice_titles = [n.get("title", "") for n in notice_list[:3]]
                    
                    auto_news = []
                    if notice_titles:
                        auto_news.append(f"최근 공시: {', '.join(notice_titles)}")
                    if news_titles:
                        auto_news.append(f"최근 뉴스: {', '.join(news_titles)}")
                    if auto_news:
                        payload["user_news_summary"] = " | ".join(auto_news)
                except Exception as e:
                    import logging
                    logging.getLogger("uvicorn").warning(f"Failed to auto fetch news for {stock_code}: {e}")

            # If user didn't provide supply_info and we have a stock code, auto fetch investor trend
            supply_info = payload.get("supply_info", "")
            if stock_code and supply_info in ("없음", "", None, "파악안됨"):
                try:
                    inv_data = naver_theme_service.fetch_investor_trend(stock_code)
                    if inv_data.get("status") == "success":
                        inst = inv_data.get("institution", {})
                        fore = inv_data.get("foreigner", {})
                        signal = inv_data.get("supply_signal", "NEUTRAL")
                        payload["supply_info"] = (
                            f"[수급 동향 ({signal})] "
                            f"당일 기관: {inst.get('today_net_buy', 0):+,}주 (최근 5일 누적 {inst.get('short_term_sum', 0):+,}주, 5일 중 {inst.get('buy_days_5d', 0)}일 순매수, {inst.get('trend')}) | "
                            f"당일 외인: {fore.get('today_net_buy', 0):+,}주 (최근 5일 누적 {fore.get('short_term_sum', 0):+,}주, 5일 중 {fore.get('buy_days_5d', 0)}일 순매수, {fore.get('trend')})"
                        )
                except Exception as e:
                    import logging
                    logging.getLogger("uvicorn").warning(f"Failed to auto fetch investor trend for {stock_code}: {e}")

            result = await closing_bet_service.evaluate_material(payload)
            return {
                "status": "success",
                "data": result
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e)
            }

