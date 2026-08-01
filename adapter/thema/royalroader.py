import json
import logging
from typing import Optional, Any, Dict, List

import requests
from pydantic import TypeAdapter

from adapter.thema.dto.ranking_dto import ThemeResponseDTO

API_THEME_URL = "https://theme.royalroader.co.kr/api/themes/ranking"


def load_realtime_theme_data() -> List[ThemeResponseDTO]:
    try:
        res = requests.get(API_THEME_URL, headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)

        # 1. 리스트 형태의 데이터를 파싱하기 위한 TypeAdapter 정의
        theme_list_adapter = TypeAdapter(List[ThemeResponseDTO])

        # 2. JSON 문자열을 역직렬화 및 검증하여 DTO 객체 리스트로 변환

        if res.status_code == 200:
            themes = theme_list_adapter.validate_json(json.dumps(res.json()))
            return themes
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
