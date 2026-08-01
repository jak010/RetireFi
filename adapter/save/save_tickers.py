from __future__ import annotations

import datetime
from typing import List

import requests

from adapter.save.define.save_tickers import SaveNewsGroup, SaveNewsName
from adapter.save.dto.container import NewsDtoContainer
from adapter.save.dto.news_detail_dto import NewsDetail
from adapter.save.dto.news_list_dto import parse_news, NewsDto


class SaveTickersClient:
    def __init__(self):
        self.base_url = "https://saveticker.com"

    def _request(self,
                 label_group: SaveNewsGroup,
                 label_name: SaveNewsName,
                 page: int = 1
                 ):
        endpoint = self.base_url + "/api/news/list"
        options = {
            "page": page,
            "page_size": 20,
            "sort": "created_at_desc",
            "label_group": label_group.value,
            "label_name": label_name.value
        }
        print(f"""
        {datetime.datetime.now()}[SAVETICKER][REQUEST_LOG] 
        - ENDPOINT={endpoint}
        - OPTIONS={options}
         """)

        r = requests.get(url=endpoint, params=options, timeout=3.0)
        if int(r.status_code) == 200:
            results = []
            for news in r.json()["news_list"]:
                results.append(parse_news(news))
            return results
        raise Exception("Failed to get list")

    def get_indicator_news(self) -> List[NewsDto]:
        result = []
        for news in self._request(SaveNewsGroup.SAVE_NEWS, SaveNewsName.INDICATOR):
            result.append(news)
        return result

    def get_all_news(self, page: int = 1) -> List[NewsDto]:
        result = []
        for news in self._request(SaveNewsGroup.SAVE_NEWS, SaveNewsName.BREAKING_NEWS, page):
            result.append(news)

        return result

    def get_news_detail(self, news_id: int) -> NewsDetail:
        endpoint = self.base_url + f"/api/news/detail?id={news_id}"
        r = requests.get(endpoint, timeout=3.0)
        if r.status_code == 200:
            return NewsDetail.from_dict(r.json())

        raise Exception(f"FAILED TO GET DETAIL: {news_id}")


class SaveTickerService:

    LABEL = "SAVE_TICKER"

    def __init__(self):
        self.save_client = SaveTickersClient()

    def get_indiactor_news(self) -> NewsDtoContainer:
        result = NewsDtoContainer()

        for news_dto in self.save_client.get_indicator_news():
            result.add(news_dto)

        return result

    def get_breaking_news(self, page: int = 5) -> NewsDtoContainer:
        """ 최근 속보 news_id 리스트 반환 """
        result = NewsDtoContainer()

        for page_number in range(1, page):
            for news_dto in self.save_client.get_all_news(page_number):
                result.add(news_dto)

        return result
