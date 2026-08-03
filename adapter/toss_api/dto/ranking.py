from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class StockPriceDTO(BaseModel):
    last_price: Decimal = Field(alias="lastPrice")
    base_price: Decimal = Field(alias="basePrice")
    change_rate: Decimal = Field(alias="changeRate")

    model_config = {
        "populate_by_name": True
    }


class StockRankingDTO(BaseModel):
    rank: int
    symbol: str
    currency: str
    price: StockPriceDTO
    trading_volume: int = Field(alias="tradingVolume")
    trading_amount: int = Field(alias="tradingAmount")

    model_config = {
        "populate_by_name": True
    }


class StockRankingResultDTO(BaseModel):
    ranked_at: datetime = Field(alias="rankedAt")
    rankings: list[StockRankingDTO]

    model_config = {
        "populate_by_name": True
    }


class StockRankingResponseDTO(BaseModel):
    result: StockRankingResultDTO
