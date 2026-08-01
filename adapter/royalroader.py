import logging
from typing import Optional, Any, Dict, List

import requests

API_THEME_URL = "https://theme.royalroader.co.kr/api/themes/ranking"


def load_realtime_theme_data() -> Optional[List[Dict[str, Any]]]:
    try:
        res = requests.get(API_THEME_URL, headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)
        return res.json() if res.status_code == 200 else None
    except Exception as e:
        logging.error(f"테마 데이터 수집 실패: {e}");
        return None


def load_realtime_indicies() -> Optional[List[Dict[str, Any]]]:
    """
    {'kosdaq': {'cur_prc': '856.50', 'flu_rt': '-3.53', 'history': [], 'pre_sig': '5', 'pred_pre': '-31.31'},
     'kospi': {'cur_prc': '8361.93', 'flu_rt': '-6.36', 'history': [], 'pre_sig': '5', 'pred_pre': '-568.37'}}
    :return:
    """
    url = "https://theme.royalroader.co.kr/api/market/indices"

    try:
        res = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)
        return res.json() if res.status_code == 200 else None
    except Exception as e:
        logging.error(f"테마 데이터 수집 실패: {e}");
        return None


if __name__ == '__main__':
    c = load_realtime_theme_data()

    total = 0
    for item in c[0]["stocks"]:
        print(item)
        total += item["trade_volume_krw"]
    print(total)

    # with open("./data.json", "w") as f:
    #     f.write(json.dumps(c, ensure_ascii=False, indent=4))
