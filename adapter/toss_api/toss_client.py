from __future__ import annotations

from typing import List, Optional
import requests
from pydantic import BaseModel
from src.config.setup import settings

from adapter.toss_api.dto.asset import PortfolioResult, PortfolioSummaryDto
from adapter.toss_api.dto.ranking import StockRankingResponseDTO


class OrderBookItem(BaseModel):
    price: str
    volume: str


class TossInvestmentAPI:
    class _Token(BaseModel):
        access_token: str
        token_type: str
        expires_in: int

    class Price(BaseModel):
        symbol: str
        timestamp: Optional[str]
        lastPrice: str
        currency: str

    class OrderBookResult(BaseModel):
        timestamp: Optional[str]
        currency: str
        asks: list[OrderBookItem]
        bids: list[OrderBookItem]

    class Trade(BaseModel):
        """ 체결가 """
        price: str
        volume: str
        timestamp: str
        currency: str

    def __init__(self):
        self.base_url = "https://openapi.tossinvest.com"
        
        # 만약 로컬 배포 스크립트를 통해 주입된 TOSS_ACCESS_TOKEN이 존재한다면 API 호출 없이 즉시 연동
        if settings.TOSS_ACCESS_TOKEN:
            token_type = settings.TOSS_TOKEN_TYPE or "Bearer"
            self.headers = {
                "Authorization": f"{token_type} {settings.TOSS_ACCESS_TOKEN}"
            }
        else:
            self._oauth_token = self.initialized()
            self.headers = {
                "Authorization": f"{self._oauth_token.token_type} {self._oauth_token.access_token}"
            }

    def initialized(self) -> _Token:
        _endpoint = "/oauth2/token"
        r = requests.post(url=self.base_url + _endpoint,
                          data={
                              "grant_type": "client_credentials",
                              "client_id": settings.TOSS_CLIENT_ID,
                              "client_secret": settings.TOSS_CLIENT_SECRET
                          })
        if r.status_code == 200:
            return self._Token(**r.json())
        raise Exception(f" Token Issued ... {r.status_code} Failed\n [Reason]:{r.text}")

    def get_current_price(self, codes: List[str]) -> List[Price]:
        """ 현재가

        Example Data
        {'result': [{'symbol': '005930', 'timestamp': '2026-06-22T19:59:59.000+09:00', 'lastPrice': '356500', 'currency': 'KRW'}]}
        """
        _endpoint = "/api/v1/prices"
        r = requests.get(url=self.base_url + _endpoint,
                         headers=self.headers,
                         params={"symbols": ','.join(codes)})
        result = []
        if r.status_code == 200:
            for row in r.json()["result"]:
                result.append(self.Price(**row))
            return result
        else:
            raise Exception(f" Prices Failed ... {r.status_code} Failed")

    def get_orderbook(self, symbol) -> OrderBookResult:
        """ 현재 호가조회 """
        _endpoint = "/api/v1/orderbook"
        r = requests.get(url=self.base_url + _endpoint,
                         headers=self.headers,
                         params={"symbol": symbol})
        if r.status_code == 200:
            data = r.json()["result"]
            return self.OrderBookResult(
                timestamp=data["timestamp"],
                currency=data["currency"],
                asks=[OrderBookItem.model_validate(ask) for ask in data["asks"]],
                bids=[OrderBookItem.model_validate(ask) for ask in data["bids"]]
            )
        raise Exception(f" OrderBook Failed ... {r.status_code} Failed")

    def get_trades(self, symbol) -> List[Trade]:
        """ 체결가 조회 """
        _endpoint = "/api/v1/trades"
        r = requests.get(url=self.base_url + _endpoint,
                         headers=self.headers,
                         params={"symbol": symbol})
        if r.status_code == 200:
            ret = []
            for r in r.json()["result"]:
                ret.append(self.Trade(**r))
            return ret
        raise Exception(f" OrderBook Failed ... {r.status_code} Failed")

    def get_my_account(self):
        """ 보유 주식 조회 """
        _endpoint = "/api/v1/accounts"
        r = requests.get(url=self.base_url + _endpoint,
                         headers=self.headers)
        print(r.json())

    def get_my_asset(self) -> List[PortfolioSummaryDto]:
        """ 보유 주식 조회 """
        _endpoint = "/api/v1/holdings"
        self.headers.update({
            "X-Tossinvest-Account": "1"
        })

        r = requests.get(url=self.base_url + _endpoint,
                         headers=self.headers)
        if r.status_code == 200:
            response = r.json()
            portfolio = PortfolioResult.model_validate(response["result"])

            result = []

            for item in portfolio.items:
                result.append(
                    PortfolioSummaryDto(
                        total_purchase_amount=portfolio.totalPurchaseAmount.krw,
                        market_value=portfolio.marketValue.amount.krw,
                        name=item.name,
                        symbol=item.symbol,
                        profit_loss_rate=item.profitLoss.rate,
                    )
                )

            return result
        return []

    def get_ranking(self) -> StockRankingResponseDTO:
        _endpoint = "/api/v1/rankings"

        self.headers.update({"X-Tossinvest-Account": "1"})

        r = requests.get(
            url=self.base_url + _endpoint,
            headers=self.headers,
            params={
                "type": "MARKET_TRADING_AMOUNT",
                "marketCountry": "KR",
                "duration": "realtime",
                "excludeInvestmentCaution": "true",
                "count": 100,
            },
        )
        if r.status_code != 200:
            raise r.raise_for_status()

        return StockRankingResponseDTO.model_validate(r.json())
