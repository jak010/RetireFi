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
    @market_entrypoint.get(path="/kiwoom-0181",
                           summary="[MARKET] : 키움증권 0181 전일대비 등락률 상위 종목 조회")
    def get_kiwoom_0181():
        return {
            "status": "success",
            "data": naver_theme_service.get_kiwoom_0181_rise_ranking()
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

