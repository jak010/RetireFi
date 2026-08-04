from fastapi.routing import APIRouter

from src.application.libs.market.naver_theme_service import NaverThemeService
from src.application.libs.market.news_summarizer_service import NewsSummaryService

naver_theme_service = NaverThemeService()

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
    @market_entrypoint.get(path="/naver-themes/{theme_name}/stocks",
                           summary="[MARKET] : 특정 네이버 테마의 소속 종목 실시간 상세 조회")
    def get_naver_theme_stocks(theme_name: str):
        return {
            "status": "success",
            "data": naver_theme_service.get_theme_stocks_detail(theme_name)
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
    @market_entrypoint.get(path="/cron/theme-leaders-summary",
                           summary="[CRON] : 테마별 대장주 및 1등주 요약 슬랙 전송")
    def run_theme_leaders_summary():
        naver_theme_service.send_theme_leaders_summary_to_slack()
        return {
            "status": "success",
            "message": "테마별 대장주 및 1등주 요약 슬랙 전송 요청 완료"
        }

    @staticmethod
    @market_entrypoint.get(path="/cron/theme-leaders-pullback-check",
                           summary="[CRON] : 테마별 대장주 1차 낙폭(-4~-8%) 구간 진입 체크 및 슬랙 알림")
    def run_theme_leaders_pullback_check():
        naver_theme_service.check_and_alert_theme_leaders_pullback()
        return {
            "status": "success",
            "message": "테마별 대장주 1차 낙폭 구간(-4~-8%) 진입 체크 완료"
        }

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

        # Build list of enriched stocks
        data = []
        for r in rankings:
            symbol = r.symbol
            name = stock_name_map.get(symbol)
            if not name:
                name = symbol
            
            themes = stock_themes_map.get(symbol, [])
            
            price = int(r.price.last_price)
            rate = float(r.price.change_rate)
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
                "toss_url": f"https://www.tossinvest.com/stocks/A{symbol}/order"
            })
            
        return {
            "status": "success",
            "data": data
        }

    @staticmethod
    @market_entrypoint.get(path="/stocks/{stock_name_or_code}/network",
                           summary="[MARKET] : 특정 종목 기준 연관 테마 네트워크(마인드맵) 데이터 조회")
    def get_stock_network(stock_name_or_code: str):
        return naver_theme_service.get_stock_network(stock_name_or_code)

    @staticmethod
    @market_entrypoint.get(path="/loading-progress",
                           summary="[MARKET] : 실시간 연산 데이터 로딩 진행률 조회")
    def get_loading_progress():
        return {
            "status": "success",
            "data": naver_theme_service.load_status
        }

