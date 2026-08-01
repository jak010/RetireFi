from datetime import datetime


from dataclasses import dataclass
from datetime import datetime
from typing import Optional, List, Dict, Any


@dataclass
class VoteOption:
    key: str
    label: str


@dataclass
class VoteSetting:
    id: str
    target_id: str
    title: str
    description: str
    options: List[VoteOption]
    multiple_choice: bool
    end_date: Optional[str]
    created_by: str
    created_at: datetime


@dataclass
class VoteStats:
    target_id: str
    vote_counts: Dict[str, int]
    total_count: int
    user_vote: Optional[str]
    vote_setting: Optional[VoteSetting]


@dataclass
class LikeStats:
    target_id: str
    like_count: int
    user_liked: bool


@dataclass
class NewsDto:
    id: str
    title: str
    content: str

    thumbnail: Optional[str]
    source: Optional[str]

    author_name: str
    author_profile_image_url: Optional[str]
    author_points: int
    author_role: str

    created_at: datetime

    view_count: int
    tag_names: List[str]
    comment_count: int

    like_stats: LikeStats
    vote_stats: VoteStats

    is_bookmarked: bool
    is_deleted: bool
    is_headline_only: bool
    is_top_story: bool
    hide_comments: bool

    translations: Optional[Any]
    extra: Optional[Any]

    news_group_id: Optional[str]
    similar_count: int
    group_summary: Optional[str]


def parse_news(item: dict) -> NewsDto:
    vote_setting_data = item["vote_stats"].get("vote_setting")


    vote_setting = None
    if vote_setting_data:
        vote_setting = VoteSetting(
            id=vote_setting_data["id"],
            target_id=vote_setting_data["target_id"],
            title=vote_setting_data["title"],
            description=vote_setting_data["description"],
            options=[
                VoteOption(**option)
                for option in vote_setting_data["options"]
            ],
            multiple_choice=vote_setting_data["multiple_choice"],
            end_date=vote_setting_data["end_date"],
            created_by=vote_setting_data["created_by"],
            created_at=datetime.fromisoformat(
                vote_setting_data["created_at"]
            ),
        )

    return NewsDto(
        id=item["id"],
        title=item["title"],
        content=item["content"],
        thumbnail=item["thumbnail"],
        source=item["source"],
        author_name=item["author_name"],
        author_profile_image_url=item["author_profile_image_url"],
        author_points=item["author_points"],
        author_role=item["author_role"],
        created_at=datetime.fromisoformat(item["created_at"]),
        view_count=item["view_count"],
        tag_names=item["tag_names"],
        comment_count=item["comment_count"],
        like_stats=LikeStats(**item["like_stats"]),
        vote_stats=VoteStats(
            target_id=item["vote_stats"]["target_id"],
            vote_counts=item["vote_stats"]["vote_counts"],
            total_count=item["vote_stats"]["total_count"],
            user_vote=item["vote_stats"]["user_vote"],
            vote_setting=vote_setting,
        ),
        is_bookmarked=item["is_bookmarked"],
        is_deleted=item["is_deleted"],
        is_headline_only=item["is_headline_only"],
        is_top_story=item["is_top_story"],
        hide_comments=item["hide_comments"],
        translations=item["translations"],
        extra=item["extra"],
        news_group_id=item["news_group_id"],
        similar_count=item["similar_count"],
        group_summary=item["group_summary"],
    )