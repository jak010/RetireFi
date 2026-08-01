import datetime
import os
from functools import cached_property

today = datetime.datetime.now().date()


class AgentQuantSwingTradingReportTemplateGenerator:

    def __init__(self,
                 prompt_template_path,
                 news,
                 market_regime,
                 sector_indicator,
                 sector_description
                 ):
        self.template_file = prompt_template_path

        self._news = news
        self._market_regime = market_regime
        self.sector_indicator = sector_indicator
        self.sector_description = sector_description

        self._encoing = "utf-8"

    @cached_property
    def template(self):
        result = None

        _target_file = os.getcwd() + self.template_file
        with open(_target_file, "r", encoding=self._encoing) as f:
            result = f.read()
        return result

    def generate(self):
        save_file_name = f"{today}-[QUANT]-[REPORT].md"

        result = self.template.format(
            news=self._news,
            market_regime=self._market_regime,
            sector_indicator=self.sector_indicator,
            sector_description=self.sector_description,
            reference_file=save_file_name
        )

        print(""" TODO
        [*] 최근 미국 증시 요약을 체크바람
        """)

        with open(save_file_name, "w", encoding=self._encoing) as f:
            f.write(result)
