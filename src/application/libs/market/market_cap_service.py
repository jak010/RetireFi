import asyncio
import httpx
import logging
from typing import Dict, List
import time

logger = logging.getLogger("uvicorn")

class MarketCapService:
    def __init__(self):
        # Cache format: { stock_code: (market_cap_str, timestamp) }
        self._cache: Dict[str, tuple[str, float]] = {}
        self.cache_ttl = 3600  # 1 hour

    def get_cached_market_caps(self, codes: List[str]) -> Dict[str, str]:
        """Return market caps that are currently in cache."""
        now = time.time()
        result = {}
        for code in codes:
            if code in self._cache:
                val, ts = self._cache[code]
                if now - ts < self.cache_ttl:
                    result[code] = val
        return result

    async def _fetch_single_market_cap(self, client: httpx.AsyncClient, code: str) -> tuple[str, str]:
        url = f"https://m.stock.naver.com/api/stock/{code}/integration"
        try:
            resp = await client.get(url, timeout=5.0)
            if resp.status_code == 200:
                data = resp.json()
                for item in data.get("totalInfos", []):
                    if item.get("code") == "marketValue":
                        return code, item.get("value", "")
        except Exception as e:
            logger.debug(f"Failed to fetch market cap for {code}: {e}")
        return code, ""

    async def fetch_market_caps_async(self, codes: List[str]) -> Dict[str, str]:
        """Fetch market caps for missing codes concurrently."""
        now = time.time()
        # Filter out cached ones
        missing_codes = [c for c in codes if c not in self._cache or (now - self._cache[c][1]) >= self.cache_ttl]
        
        if not missing_codes:
            return self.get_cached_market_caps(codes)

        logger.info(f"Fetching market caps for {len(missing_codes)} stocks...")
        results = {}
        async with httpx.AsyncClient(headers={"User-Agent": "Mozilla/5.0"}) as client:
            tasks = [self._fetch_single_market_cap(client, c) for c in missing_codes]
            fetched = await asyncio.gather(*tasks, return_exceptions=True)
            
            for res in fetched:
                if isinstance(res, tuple) and len(res) == 2:
                    code, val = res
                    if val:
                        self._cache[code] = (val, now)
                        results[code] = val

        # Combine with already cached
        for c in codes:
            if c in self._cache:
                results[c] = self._cache[c][0]
                
        return results

    def fetch_market_caps_sync(self, codes: List[str]) -> Dict[str, str]:
        """Helper to run the async fetch in a synchronous context."""
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
        return loop.run_until_complete(self.fetch_market_caps_async(codes))

market_cap_service = MarketCapService()
