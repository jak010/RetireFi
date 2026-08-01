import logging
from datetime import datetime
from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from adapter.save.save_tickers import SaveTickerService
from adapter.slack.client import SlackClient
from src.config.setup import settings

logger = logging.getLogger(__name__)

class NewsSummaryService:
    def __init__(self):
        try:
            self.save_ticker = SaveTickerService()
        except Exception as e:
            logger.warning(f"SaveTickerService 초기화 실패: {e}")
            self.save_ticker = None
            
        self.slack = SlackClient(token=settings.SLACK_TOKEN) if settings.SLACK_TOKEN else None

    def execute_summary_and_alert(self) -> str:
        """
        최신 속보 뉴스를 가져와 Gemini LLM을 통해 요약 브리핑을 생성하고 슬랙 채널로 발송합니다.
        """
        if not self.save_ticker:
            logger.warning("SaveTickerService가 준비되지 않아 요약을 생략합니다.")
            return "SaveTickerService Not Initialized"

        try:
            # 1. 속보 뉴스 리스트 조회 (최신 10개)
            news_container = self.save_ticker.get_breaking_news(page=2)
            articles = news_container.news_list[:10]
            if not articles:
                logger.info("요약할 속보 뉴스가 존재하지 않습니다.")
                return "No Articles Found"

            # 2. 요약용 텍스트 가공
            input_text = ""
            for news in articles:
                time_str = news.created_at.strftime("%Y-%m-%d %H:%M")
                input_text += f"{time_str} / {news.title} / {news.source or '속보'}\n"

            # 3. Gemini LLM을 통한 요약 실행
            gemini = ChatGoogleGenerativeAI(
                model="gemini-2.5-flash",
                temperature=0,
                google_api_key=settings.GOOGLE_API_KEY
            )

            prompt = ChatPromptTemplate.from_messages([
                ("system", """
                # 역할
                * 너는 글로벌 헤지펀드에서 근무하는 수석 시장분석관이다.
                * 주어진 원시 속보 뉴스 데이터를 핵심 정보 브리핑으로 압축 및 시장 방향성 분석을 제공해야 한다.

                # 출력 제약 사항
                1. 한국어로 작성하라.
                2. 첫 줄은 반드시 "📢 [INVESTRA 실시간 마켓 브리핑]" 으로 시작하라.
                3. 일자별/시간별 주요 정세 변화를 인과관계가 보이도록 콤팩트한 불릿 포인트 형태로 요약하라.
                4. 마지막에는 전체 뉴스를 관통하는 [시장 주요 시사점 및 영향]을 1~2문장으로 한눈에 요약하라.
                """),
                ("human", "다음 뉴스 데이터를 마켓 브리핑 형태로 요약해줘:\n{INPUT_TEXT}")
            ])

            chain = prompt | gemini
            summary_content = chain.invoke({"INPUT_TEXT": input_text}).content

            # 4. 슬랙 채널 발송
            if self.slack:
                try:
                    self.slack.get_client.chat_postMessage(
                        channel=SlackClient.FINANCE_CHNNAEL,
                        text=summary_content
                    )
                    logger.info("✅ 뉴스 요약 브리핑 슬랙 발송 완료")
                except Exception as e:
                    logger.error(f"뉴스 요약 슬랙 발송 실패: {e}")
            else:
                logger.info(f"뉴스 요약 결과 (Slack 미연동):\n{summary_content}")

            return summary_content

        except Exception as e:
            logger.error(f"뉴스 요약 작업 중 에러 발생: {e}")
            return f"Error: {str(e)}"
