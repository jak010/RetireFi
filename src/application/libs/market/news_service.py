import logging
import asyncio
import requests
from bs4 import BeautifulSoup
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

class NewsService:
    def __init__(self):
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://finance.naver.com/"
        }
        self._cache = {}
        self.CACHE_TTL = 60 * 2  # 2 minutes

    async def _fetch_html(self, url: str) -> str:
        try:
            response = await asyncio.to_thread(
                requests.get, url, headers=self.headers, timeout=5
            )
            if response.status_code == 200:
                response.encoding = 'euc-kr'
                return response.text
            else:
                logger.error(f"Failed to fetch {url}, status: {response.status_code}")
                return ""
        except Exception as e:
            logger.error(f"Error fetching {url}: {e}")
            return ""

    async def get_news(self, code: str) -> List[Dict[str, str]]:
        cache_key = f"news_{code}"
        now = asyncio.get_event_loop().time()
        if cache_key in self._cache and now - self._cache[cache_key]["timestamp"] < self.CACHE_TTL:
            return self._cache[cache_key]["data"]

        url = f"https://finance.naver.com/item/news_news.naver?code={code}&page=1&sm=title_entity_id.basic&clusterId="
        html = await self._fetch_html(url)
        if not html:
            return []

        soup = BeautifulSoup(html, "html.parser")
        table = soup.select_one("table.type5")
        if not table:
            return []

        news_list = []
        for row in table.select("tr"):
            title_td = row.select_one("td.title")
            if not title_td:
                continue

            a_tag = title_td.select_one("a")
            if not a_tag:
                continue

            title = a_tag.text.strip()
            link = "https://finance.naver.com" + a_tag.get('href')

            info_tds = row.select("td.info")
            publisher = info_tds[0].text.strip() if len(info_tds) > 0 else ""

            date_td = row.select_one("td.date")
            date_str = date_td.text.strip() if date_td else ""

            news_list.append({
                "title": title,
                "link": link,
                "publisher": publisher,
                "date": date_str
            })
            
            if len(news_list) >= 10:  # Limit to 10 latest news
                break

        self._cache[cache_key] = {"data": news_list, "timestamp": now}
        return news_list

    async def get_disclosures(self, code: str) -> List[Dict[str, str]]:
        cache_key = f"notice_{code}"
        now = asyncio.get_event_loop().time()
        if cache_key in self._cache and now - self._cache[cache_key]["timestamp"] < self.CACHE_TTL:
            return self._cache[cache_key]["data"]

        url = f"https://finance.naver.com/item/news_notice.naver?code={code}&page=1"
        html = await self._fetch_html(url)
        if not html:
            return []

        soup = BeautifulSoup(html, "html.parser")
        table = soup.select_one("table.type6")
        if not table:
            return []

        notice_list = []
        for row in table.select("tr"):
            title_td = row.select_one("td.title")
            if not title_td:
                continue

            a_tag = title_td.select_one("a")
            if not a_tag:
                continue

            title = a_tag.text.strip()
            link = "https://finance.naver.com" + a_tag.get('href')

            info_tds = row.select("td.info")
            publisher = info_tds[0].text.strip() if len(info_tds) > 0 else ""

            date_td = row.select_one("td.date")
            date_str = date_td.text.strip() if date_td else ""

            notice_list.append({
                "title": title,
                "link": link,
                "publisher": publisher,
                "date": date_str
            })
            
            if len(notice_list) >= 10:  # Limit to 10 latest notices
                break

        self._cache[cache_key] = {"data": notice_list, "timestamp": now}
        return notice_list
