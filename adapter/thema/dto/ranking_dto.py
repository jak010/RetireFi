from typing import List, Any

from pydantic import BaseModel, Field, computed_field


class StockDTO(BaseModel):
    """테마에 속한 개별 종목 정보 DTO"""
    stock_code: str
    stock_name: str
    current_price_krw: int
    market_cap_krw: int
    stock_rate: float
    trade_volume_krw: int


class ThemeResponseDTO(BaseModel):
    """주식 테마 정보 응답 DTO"""
    id: int
    name: str
    advancing_count: int  # 상승종목 수
    declining_count: int  # 하락 종목 수
    calculated_rate: float  # 섹터의 등락률
    leader_stock: str
    total_market_cap: int
    stocks: List[StockDTO]

    # JSON에서 빈 배열로 들어오므로 임시로 List[Any] 처리 및 기본값 생성 규칙 지정
    today_briefings: List[Any] = Field(default_factory=list)
    today_news: List[Any] = Field(default_factory=list)

    @computed_field
    @property
    def total_trade_volume_krw(self) -> int:
        """하위 종목(stocks)들의 trade_volume_krw를 합산하여 총 거래대금을 계산합니다."""
        return sum(stock.trade_volume_krw for stock in self.stocks)

    @computed_field
    @property
    def total_stock_rate(self) -> float:
        """하위 종목(stocks)들의 trade_volume_krw를 합산하여 총 거래대금을 계산합니다."""
        return sum(stock.stock_rate for stock in self.stocks)
