import os
import asyncio
from datetime import datetime, timedelta

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from src.application.api.market_router import market_entrypoint


class Application:

    def __init__(self):
        self.app = FastAPI(
            title="투자 대시보드 애플리케이션"
        )

        self.configure_static()
        self.configure_routes()
        self.configure_events()

    def configure_static(self):
        static_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "static"
        )

        if not os.path.exists(static_dir):
            os.makedirs(static_dir)

        self.app.mount(
            "/static",
            StaticFiles(directory=static_dir),
            name="static"
        )

    def configure_routes(self):
        self.app.include_router(market_entrypoint)

        @self.app.get(
            "/",
            response_class=HTMLResponse,
            tags=["UI"]
        )
        def read_root():
            current_dir = os.path.dirname(
                os.path.abspath(__file__)
            )

            template_path = os.path.join(
                current_dir,
                "templates",
                "index.html"
            )

            if os.path.exists(template_path):
                with open(
                        template_path,
                        "r",
                        encoding="utf-8"
                ) as f:
                    return HTMLResponse(
                        content=f.read()
                    )

            return HTMLResponse(
                content="<h2>로얄로더 & 네이버 테마 매트릭스 대시보드가 준비 중입니다.</h2>"
            )

    def configure_events(self):

        @self.app.on_event("startup")
        async def startup_event():
            # Vercel 환경에서는 장기 실행 scheduler 비활성화
            if os.getenv("VERCEL"):
                print(
                    "[INFO] Vercel environment detected. "
                    "Background scheduler disabled."
                )
                return

            # 서버 시작 시 비동기로 첫 캐시 수집 작동 (웜업)
            import threading
            from src.application.api.market_router import naver_theme_service
            
            def warm_cache():
                print("[INFO] Background cache warming started...")
                naver_theme_service.get_naver_themes_summary()
                print("[INFO] Background cache warming finished!")

            threading.Thread(target=warm_cache, daemon=True).start()
            asyncio.create_task(self.schedule_theme_leaders_summary_loop())
            asyncio.create_task(self.schedule_theme_leaders_pullback_loop())

    async def schedule_theme_leaders_pullback_loop(self):
        from src.application.api.market_router import naver_theme_service

        # 초기 기동 후 캐시 수집 완료 대기
        await asyncio.sleep(30)

        while True:
            try:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    naver_theme_service.check_and_alert_theme_leaders_pullback
                )
            except Exception as e:
                print(f"[BACKGROUND THEME LEADER PULLBACK MONITOR ERROR] {e}")

            # 3분(180초) 주기로 실시간 낙폭 진입 감지
            await asyncio.sleep(180.0)

    async def schedule_theme_leaders_summary_loop(self):
        from src.application.api.market_router import naver_theme_service

        # 초기 기동 후 첫 매핑 및 통계 수집(웜업) 대기
        await asyncio.sleep(20)

        while True:
            try:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    naver_theme_service.send_theme_leaders_summary_to_slack
                )
            except Exception as e:
                print(f"[BACKGROUND THEME LEADER SUMMARY ERROR] {e}")

            now = datetime.now()
            # 30분 단위 정시 구하기 (예: 매 시간 0분, 30분)
            minutes_to_add = 30 - (now.minute % 30)
            next_run = (
                now + timedelta(minutes=minutes_to_add)
            ).replace(
                second=0,
                microsecond=0
            )
            sleep_seconds = (next_run - datetime.now()).total_seconds()
            if sleep_seconds <= 0:
                sleep_seconds = 1800.0

            await asyncio.sleep(max(1.0, sleep_seconds))

    async def schedule_news_summary_loop(self):

        from src.application.libs.market.news_summarizer_service import (
            NewsSummaryService
        )

        service = NewsSummaryService()

        await asyncio.sleep(10)

        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                service.execute_summary_and_alert
            )

        except Exception as e:
            print(
                f"[BACKGROUND CRON INITIAL ERROR] {e}"
            )

        while True:

            now = datetime.now()

            # 10분 단위 정시 구하기 (예: 10분, 20분, 30분 ...)
            minutes_to_add = 10 - (now.minute % 10)
            next_run = (
                    now + timedelta(minutes=minutes_to_add)
            ).replace(
                second=0,
                microsecond=0
            )

            sleep_seconds = (
                    next_run - now
            ).total_seconds()

            await asyncio.sleep(
                max(1.0, sleep_seconds)
            )

            try:

                loop = asyncio.get_event_loop()

                await loop.run_in_executor(
                    None,
                    service.execute_summary_and_alert
                )

            except Exception as e:

                print(
                    f"[BACKGROUND CRON LOOP ERROR] {e}"
                )


app = Application().app
