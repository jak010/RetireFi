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
        return {
            "status": "success",
            "data": res["themes"],
            "top_themes_5": res["top_themes_5"],
            "leader_sectors_3": res["leader_sectors_3"],
            "recent_news": res.get("recent_news", []),
            "indices": res.get("indices", {})
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
                           summary="[CRON] : 최신 마켓 속보 요약 및 슬랙 브리핑 전송")
    def run_news_summary():
        service = NewsSummaryService()
        summary = service.execute_summary_and_alert()
        return {
            "status": "success",
            "summary": summary
        }

