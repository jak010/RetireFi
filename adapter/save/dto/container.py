from functools import cached_property
from pprint import pprint
from typing import List

from adapter.save.dto.news_list_dto import NewsDto


class NewsDtoContainer:

    def __init__(self):
        self.news_list: List[NewsDto] = []

    def __iter__(self):
        return iter(self.news_list)

    def add(self, news_dto: NewsDto):
        return self.news_list.append(news_dto)

    def size(self):
        return len(self.news_list)

    @cached_property
    def get_news_ids(self) -> List[str]:
        return [news.id for news in self.news_list]

    def stats(self):
        pprint({
            "count": self.size(),
            "time_range": f"{self.news_list[-1].created_at.isoformat()} ~ {self.news_list[0].created_at.isoformat()}",
            "tags": set([tag for news in self.news_list for tag in news.tag_names]),
            "tag_names": set([tag for tag in self.news_list[0].tag_names])
        })
