import requests
from bs4 import BeautifulSoup
import pandas as pd
import time

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}


class ThemeStockMapper:
    def __init__(self):
        self.mapping_df = pd.DataFrame()

    def get_theme_list(self, max_pages=2):
        """네이버 증권 테마 목록 수집 (기본 2페이지까지 수집)"""
        print("🔍 테마 목록 수집 중...")
        themes = []

        for page in range(1, max_pages + 1):
            url = f"https://finance.naver.com/sise/theme.naver?page={page}"
            res = requests.get(url, headers=HEADERS)
            soup = BeautifulSoup(res.text, 'html.parser')

            rows = soup.select('table.type_1 tr')
            for row in rows:
                cols = row.select('td.col_type1 a')
                if cols:
                    theme_name = cols[0].text.strip()
                    theme_no = cols[0]['href'].split('no=')[-1]
                    themes.append({
                        'theme_no': theme_no,
                        'theme_name': theme_name
                    })
            time.sleep(0.1)

        print(f"✅ 총 {len(themes)}개 테마 수집 완료!")
        return themes

    def get_stocks_in_theme(self, theme_no, theme_name):
        """특정 테마 고유번호에 속한 종목 리스트 수집"""
        url = f"https://finance.naver.com/sise/sise_group_detail.naver?type=theme&no={theme_no}"
        res = requests.get(url, headers=HEADERS)
        soup = BeautifulSoup(res.text, 'html.parser')

        stocks = []
        rows = soup.select('table.type_5 tr')
        for row in rows:
            name_td = row.select('td.name a')
            desc_td = row.select('td.info_add')  # 편입/연관 사유 요약

            if name_td:
                stock_name = name_td[0].text.strip()
                stock_code = name_td[0]['href'].split('code=')[-1]
                description = desc_td[0].text.strip() if desc_td else ""

                stocks.append({
                    'theme_no': theme_no,
                    'theme_name': theme_name,
                    'stock_code': stock_code,
                    'stock_name': stock_name,
                    'description': description
                })
        return stocks

    def build_mapping_data(self, max_pages=1, limit_themes=None):
        """전체 테마-종목 매핑 데이터 생성 및 병합"""
        themes = self.get_theme_list(max_pages=max_pages)
        if limit_themes:
            themes = themes[:limit_themes]

        all_records = []
        print(f"🚀 테마별 포함 종목 수집 시작 (대상 테마 수: {len(themes)}개)...")

        for idx, theme in enumerate(themes, start=1):
            t_no = theme['theme_no']
            t_name = theme['theme_name']

            stocks = self.get_stocks_in_theme(t_no, t_name)
            all_records.extend(stocks)
            print(f"[{idx}/{len(themes)}] '{t_name}' ({len(stocks)}개 종목 수집)")
            time.sleep(0.1)  # 서버 과부하 방지

        self.mapping_df = pd.DataFrame(all_records)
        print("\n🎉 매핑 데이터 생성 완료!")
        return self.mapping_df

    # ------------------ 데이터 확인 및 조회 함수 ------------------

    def search_by_stock(self, stock_name):
        """[검증 1] 특정 종목이 어떤 테마에 속해 있는지 조회"""
        if self.mapping_df.empty:
            print("데이터가 생성되지 않았습니다.")
            return None

        result = self.mapping_df[self.mapping_df['stock_name'].str.contains(stock_name, na=False)]
        print(f"\n🔎 [{stock_name}] 검색 결과 (속한 테마 수: {len(result)}개):")
        return result[['stock_code', 'stock_name', 'theme_name', 'description']]

    def search_by_theme(self, theme_keyword):
        """[검증 2] 특정 테마에 어떤 종목들이 속해 있는지 조회"""
        if self.mapping_df.empty:
            print("데이터가 생성되지 않았습니다.")
            return None

        result = self.mapping_df[self.mapping_df['theme_name'].str.contains(theme_keyword, na=False)]
        print(f"\n🔎 [{theme_keyword}] 테마 구성 종목 (총 {len(result)}개):")
        return result[['theme_name', 'stock_code', 'stock_name', 'description']]


# ==================== 실행 예시 ====================
if __name__ == "__main__":
    mapper = ThemeStockMapper()

    # 1. 테마 1페이지 내 20개 테마 수집
    df = mapper.build_mapping_data(max_pages=1, limit_themes=20)

    # 2. 전체 매핑 데이터 미리보기 (상위 10개 레코드)
    print("\n--- [매핑 데이터 샘플] ---")
    print(df.head(10)[['theme_name', 'stock_name', 'stock_code']])