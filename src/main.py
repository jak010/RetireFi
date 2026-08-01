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

        return self.app


app = Application()


