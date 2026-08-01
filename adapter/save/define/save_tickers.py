from __future__ import annotations

from enum import Enum


class SaveNewsGroup(Enum):
    ALL = 1
    SAVE_NEWS = 2
    FINANCE_NEWS = 4


class SaveNewsName(Enum):
    ALL = 1
    BREAKING_NEWS = 3
    INFORMATION = 4
    INDICATOR = 7
