from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel


class CurrencyAmount(BaseModel):
    krw: Optional[Decimal] = None
    usd: Optional[Decimal] = None


class MarketValueSummary(BaseModel):
    amount: CurrencyAmount
    amountAfterCost: CurrencyAmount


class ProfitLossSummary(BaseModel):
    amount: CurrencyAmount
    amountAfterCost: CurrencyAmount
    rate: Decimal
    rateAfterCost: Decimal


class DailyProfitLossSummary(BaseModel):
    amount: CurrencyAmount
    rate: Decimal


class ItemMarketValue(BaseModel):
    purchaseAmount: Decimal
    amount: Decimal
    amountAfterCost: Decimal


class ItemProfitLoss(BaseModel):
    amount: Decimal
    amountAfterCost: Decimal
    rate: Decimal
    rateAfterCost: Decimal


class ItemDailyProfitLoss(BaseModel):
    amount: Decimal
    rate: Decimal


class ItemCost(BaseModel):
    commission: Decimal
    tax: Optional[Decimal] = None


class PortfolioItem(BaseModel):
    symbol: str
    name: str
    marketCountry: str
    currency: str
    quantity: Decimal
    lastPrice: Decimal
    averagePurchasePrice: Decimal

    marketValue: ItemMarketValue
    profitLoss: ItemProfitLoss
    dailyProfitLoss: ItemDailyProfitLoss
    cost: ItemCost


class PortfolioResult(BaseModel):
    totalPurchaseAmount: CurrencyAmount
    marketValue: MarketValueSummary
    profitLoss: ProfitLossSummary
    dailyProfitLoss: DailyProfitLossSummary
    items: List[PortfolioItem]

class PortfolioSummaryDto(BaseModel):
    total_purchase_amount: Decimal
    market_value: Decimal
    name:str
    symbol: str
    profit_loss_rate: Decimal