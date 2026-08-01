import datetime
import os
from functools import cached_property

today = datetime.datetime.now().date()


class WeeklyPredictMarketReport:

    def __init__(self,
                 prompt_template_path,
                 ):
        self._encoing = "utf-8"
        self.save_file_name = f"{today}-[WEEKLY]-[MARKET].md"
        self.template_file = prompt_template_path

    @cached_property
    def template(self):
        result = None
        _target_file = os.getcwd() + self.template_file
        with open(_target_file, "r", encoding=self._encoing) as f:
            result = f.read()
        return result

    def generate(self,
                 latest_market_news,
                 market_news,
                 next_week
                 ):
        result = self.template.format(
            latest_market_news="", # 마지막 거래일의 요약 뉴스
            market_news=market_news,  # 주차별 뉴스 목록
            next_week=next_week,  # 다음 주 주요 일정
            reference_file=self.save_file_name
        )

        with open(self.save_file_name, "w", encoding=self._encoing) as f:
            f.write(result)
