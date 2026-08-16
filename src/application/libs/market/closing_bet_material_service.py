import logging
import json
from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from src.config.setup import settings

logger = logging.getLogger(__name__)

class ClosingBetMaterialService:
    def __init__(self):
        self.llm = ChatGoogleGenerativeAI(
            model="gemini-flash-latest", # Use gemini-flash-latest
            temperature=0.2, # Low temperature for more analytical consistency
            google_api_key=settings.GOOGLE_API_KEY
        )

    async def evaluate_material(self, request_data: dict) -> dict:
        """
        사용자가 입력한 종목 정보와 수급 정보를 바탕으로 종가베팅 재료의 유효성을 분석합니다.
        """
        try:
            prompt = ChatPromptTemplate.from_messages([
                ("system", """
                당신은 대한민국 주식 시장에서 트레이딩을 전문으로 하는 수석 투자 분석가입니다.
                당신의 목표는 '종가베팅(장 마감 전 매수하여 다음날 장 초반 매도)'을 위한 후보 종목의 상승 재료를 분석하고 그 신뢰도를 평가하는 것입니다.
                
                핵심 질문은 다음과 같습니다: "이 종목은 오늘 왜 올랐으며, 그 이유가 내일도 시장에서 유효한가?"
                수급은 상승의 '현상'이고, 재료는 상승의 '원인'입니다. 절대로 수급이나 단순 거래량 증가를 재료로 취급하지 마십시오.
                
                다음 원칙에 따라 분석하십시오:
                1. 개별 종목의 주요 뉴스 및 공시를 최우선으로 고려합니다.
                2. 개별 뉴스가 뚜렷하지 않다면, 해당 종목이 속한 테마/섹터 전체의 움직임과 대장주 여부를 판단합니다.
                3. 해외 동일 섹터의 움직임이 국내에 미칠 영향을 고려합니다.
                4. 해당 재료가 단발성인지, 내일 아침에도 시장의 관심을 받을 수 있는 강한 재료인지 판단합니다.
                5. 악재나 이벤트(실적 발표, 보호예수, 유상증자 등)가 있는지 고려합니다.
                6. 모든 조사가 끝나면 상승 재료를 [원인] -> [산업/테마 영향] -> [종목 수혜] 형태의 한 문장으로 정의합니다.
                7. 신뢰도를 A, B, C, D, F 로 평가하고, D 이하는 종가베팅 대상에서 '제외'합니다.
                
                결과는 반드시 다음 JSON 형식으로만 반환해야 합니다:
                {{
                    "stock_name": "종목명",
                    "cause_of_rise": "상승 원인 상세 설명",
                    "core_material": "핵심 재료 요약 ([원인] -> [산업/테마 영향] -> [종목 수혜] 형식)",
                    "related_theme": "관련 테마",
                    "theme_cause": "테마 상승 원인",
                    "leader_stock": "대장주 여부 및 대장주 이름",
                    "same_material_as_leader": "대장주와 동일 재료 여부 (예/아니오/해당없음)",
                    "overseas_sector": "해외 동일 섹터 동향 및 영향",
                    "valid_tomorrow_reason": "내일도 유효한 이유",
                    "risk_events": "확인된 악재/이벤트",
                    "material_reliability": "A/B/C/D/F",
                    "final_decision": "진입 / 관찰 / 제외",
                    "final_reason": "최종 판단 근거 (수급을 제외하더라도 내일 보유할 이유가 있는가?)"
                }}
                """),
                ("human", """
                다음 종목 정보를 바탕으로 종가베팅 재료 유효성을 분석하고 JSON으로 결과를 반환해주세요.
                
                [입력 데이터]
                - 종목명: {stock_name}
                - 당일 등락률: {rate}%
                - 거래량 변화: {volume_change}
                - 외국인/기관 수급: {supply_info}
                - 오후 수급 변화: {afternoon_supply}
                - 관련 테마/섹터: {themes}
                - 현재가 및 종가 위치 특이사항: {price_position}
                - 기타 사용자가 파악한 뉴스/공시 요약: {user_news_summary}
                """)
            ])

            chain = prompt | self.llm
            response = chain.invoke(request_data)
            
            # Extract JSON block if it's wrapped in markdown
            content = response.content
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].strip()
                
            return json.loads(content)

        except Exception as e:
            logger.error(f"종가베팅 재료 검증 중 오류 발생: {e}")
            raise e
