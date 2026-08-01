import os
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from src.application.api.market_router import market_entrypoint


class Application:

    def __init__(self):
        self.app = FastAPI(
            title="투자 대시보드 애플리케이션"
        )
        # Mount static directory for external CSS & JS
        static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
        if not os.path.exists(static_dir):
            os.makedirs(static_dir)
        self.app.mount("/static", StaticFiles(directory=static_dir), name="static")

    def __call__(self, *args, **kwargs):
        self.app.include_router(market_entrypoint)

        # 루트 경로 진입 시 대시보드 index.html 렌더링
        @self.app.get("/", response_class=HTMLResponse, tags=["UI"])
        def read_root():
            current_dir = os.path.dirname(os.path.abspath(__file__))
            template_path = os.path.join(current_dir, "templates", "index.html")
            if os.path.exists(template_path):
                with open(template_path, "r", encoding="utf-8") as f:
                    return HTMLResponse(content=f.read())
            return HTMLResponse(content="<h2>로얄로더 & 네이버 테마 매트릭스 대시보드가 준비 중입니다.</h2>")

        # Uvicorn/FastAPI 기동 시 정각마다 도는 뉴스 요약 스케줄러 태스크 추가
        @self.app.on_event("startup")
        async def startup_event():
            import asyncio
            from datetime import datetime, timedelta
            from src.application.libs.market.news_summarizer_service import NewsSummaryService

            async def schedule_news_summary_loop():
                service = NewsSummaryService()
                # 구동 10초 후 최초 1회 동작하여 작동 확인
                await asyncio.sleep(10)
                try:
                    loop = asyncio.get_event_loop()
                    await loop.run_in_executor(None, service.execute_summary_and_alert)
                except Exception as e:
                    print(f"[BACKGROUND CRON INITIAL ERROR] {e}")

                while True:
                    now = datetime.now()
                    next_hour = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
                    sleep_seconds = (next_hour - now).total_seconds()
                    await asyncio.sleep(max(1.0, sleep_seconds))
                    
                    try:
                        loop = asyncio.get_event_loop()
                        await loop.run_in_executor(None, service.execute_summary_and_alert)
                    except Exception as e:
                        print(f"[BACKGROUND CRON LOOP ERROR] {e}")

            asyncio.create_task(schedule_news_summary_loop())

        return self.app


app = Application()


