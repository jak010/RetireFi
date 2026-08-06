from __future__ import annotations

import time
import logging
from typing import List, Optional
import requests
from pydantic import BaseModel
from src.config.setup import settings

from adapter.toss_api.dto.asset import PortfolioResult, PortfolioSummaryDto
from adapter.toss_api.dto.ranking import StockRankingResponseDTO

logger = logging.getLogger("uvicorn")


class OrderBookItem(BaseModel):
    price: str
    volume: str


class TossInvestmentAPI:
    _cached_token: Optional[str] = None
    _cached_token_type: str = "Bearer"
    _token_expiry: float = 0.0

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
        self.headers = self._get_auth_headers(force_refresh=False)

    @classmethod
    def _get_auth_headers(cls, force_refresh: bool = False) -> dict:
        current_time = time.time()
        # 1. 캐시된 유효 토큰이 있을 경우 네트워크 호출 없이 즉시 사용
        if not force_refresh and cls._cached_token and current_time < cls._token_expiry:
            return {"Authorization": f"{cls._cached_token_type} {cls._cached_token}"}

        # 2. 강제 갱신이 아니고 초기 설정에 TOSS_ACCESS_TOKEN이 명시적으로 설정되어 있고 최초 시도일 경우
        if not force_refresh and settings.TOSS_ACCESS_TOKEN and not cls._cached_token:
            token_type = settings.TOSS_TOKEN_TYPE or "Bearer"
            cls._cached_token = settings.TOSS_ACCESS_TOKEN
            cls._cached_token_type = token_type
            cls._token_expiry = current_time + 3600  # 환경변수 토큰은 임시로 1시간 유효로 설정 (만료 시 자동 복구됨)
            return {"Authorization": f"{token_type} {cls._cached_token}"}

        # 3. 신규 토큰 발급 또는 강제 재발급 (client_credentials)
        base_url = "https://openapi.tossinvest.com"
        _endpoint = "/oauth2/token"
        r = requests.post(
            url=base_url + _endpoint,
            data={
                "grant_type": "client_credentials",
                "client_id": settings.TOSS_CLIENT_ID,
                "client_secret": settings.TOSS_CLIENT_SECRET,
            },
            timeout=10,
        )
        if r.status_code == 200:
            token_data = r.json()
            cls._cached_token = token_data["access_token"]
            cls._cached_token_type = token_data.get("token_type", "Bearer")
            expires_in = int(token_data.get("expires_in", 86399))
            # 만료 시간보다 5분 여유롭게 캐싱
            cls._token_expiry = current_time + max(expires_in - 300, 60)
            return {"Authorization": f"{cls._cached_token_type} {cls._cached_token}"}
        
        raise Exception(f" Token Issued ... {r.status_code} Failed\n [Reason]:{r.text}")

    def initialized(self) -> _Token:
        _endpoint = "/oauth2/token"
        r = requests.post(
            url=self.base_url + _endpoint,
            data={
                "grant_type": "client_credentials",
                "client_id": settings.TOSS_CLIENT_ID,
                "client_secret": settings.TOSS_CLIENT_SECRET,
            },
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            TossInvestmentAPI._cached_token = data["access_token"]
            TossInvestmentAPI._cached_token_type = data.get("token_type", "Bearer")
            TossInvestmentAPI._token_expiry = time.time() + max(int(data.get("expires_in", 86399)) - 300, 60)
            return self._Token(**data)
        raise Exception(f" Token Issued ... {r.status_code} Failed\n [Reason]:{r.text}")

    def _request(self, method: str, endpoint: str, headers: Optional[dict] = None, params: Optional[dict] = None, **kwargs) -> requests.Response:
        req_headers = dict(self.headers)
        if headers:
            req_headers.update(headers)
            
        url = self.base_url + endpoint
        r = requests.request(method=method, url=url, headers=req_headers, params=params, timeout=10, **kwargs)
        
        # 401 Unauthorized 오류 감지 시 자율 복구: 토큰 강제 갱신 후 1회 재동작
        if r.status_code == 401:
            logger.warning(f"Toss API 401 Unauthorized at {endpoint}. Refreshing token automatically and retrying...")
            new_auth_header = self._get_auth_headers(force_refresh=True)
            self.headers.update(new_auth_header)
            req_headers.update(new_auth_header)
            r = requests.request(method=method, url=url, headers=req_headers, params=params, timeout=10, **kwargs)
            
        return r

    def get_current_price(self, codes: List[str]) -> List[Price]:
        """ 현재가

        Example Data
        {'result': [{'symbol': '005930', 'timestamp': '2026-06-22T19:59:59.000+09:00', 'lastPrice': '356500', 'currency': 'KRW'}]}
        """
        _endpoint = "/api/v1/prices"
        r = self._request("GET", _endpoint, params={"symbols": ','.join(codes)})
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
        r = self._request("GET", _endpoint, params={"symbol": symbol})
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
        r = self._request("GET", _endpoint, params={"symbol": symbol})
        if r.status_code == 200:
            ret = []
            for row in r.json()["result"]:
                ret.append(self.Trade(**row))
            return ret
        raise Exception(f" OrderBook Failed ... {r.status_code} Failed")

    def get_my_account(self):
        """ 보유 주식 조회 """
        _endpoint = "/api/v1/accounts"
        r = self._request("GET", _endpoint)
        print(r.json())

    def get_my_asset(self) -> List[PortfolioSummaryDto]:
        """ 보유 주식 조회 """
        _endpoint = "/api/v1/holdings"
        r = self._request("GET", _endpoint, headers={"X-Tossinvest-Account": "1"})
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

    def get_ranking(self, ranking_type: str = "MARKET_TRADING_AMOUNT", duration: str = "realtime", count: int = 100) -> StockRankingResponseDTO:
        _endpoint = "/api/v1/rankings"
        r = self._request(
            method="GET",
            endpoint=_endpoint,
            headers={"X-Tossinvest-Account": "1"},
            params={
                "type": ranking_type,
                "marketCountry": "KR",
                "duration": duration,
                "excludeInvestmentCaution": "true",
                "count": count,
            },
        )
        if r.status_code != 200:
            raise r.raise_for_status()

        return StockRankingResponseDTO.model_validate(r.json())
