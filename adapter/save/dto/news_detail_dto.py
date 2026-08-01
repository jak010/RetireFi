from datetime import datetime
from dataclasses import dataclass
from typing import List, Optional, Any, Dict


# -------------------------
# Content
# -------------------------
@dataclass
class ContentItem:
    type: str
    content: str


# -------------------------
# Tag / Label
# -------------------------
@dataclass
class Tag:
    id: int
    mongo_id: Optional[str]
    name: str
    is_ticker: bool


@dataclass
class ContentLabel:
    id: int
    name: str


# -------------------------
# Vote
# -------------------------
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
    created_at: str


@dataclass
class VoteCounts:
    negative: int = 0
    positive: int = 0


@dataclass
class VoteStats:
    target_id: str
    vote_counts: VoteCounts
    total_count: int
    user_vote: Optional[Any]
    vote_setting: VoteSetting


# -------------------------
# Like
# -------------------------
@dataclass
class LikeStats:
    target_id: str
    like_count: int
    user_liked: bool


# -------------------------
# Main Entity
# -------------------------
@dataclass
class NewsDetail:
    id: str
    title: str
    content: List[ContentItem]

    source: Optional[str]
    author_id: str
    author_name: str
    author_profile_image_url: Optional[str]
    author_points: int
    author_role: str

    created_at: str
    updated_at: str

    view_count: int
    tags: List[Tag]
    tickers: List[Any]
    content_labels: List[ContentLabel]

    vote_stats: VoteStats
    comment_count: int

    like_stats: LikeStats

    is_bookmarked: bool
    is_deleted: bool
    is_top_story: bool
    hide_comments: bool

    translations: Optional[Any]
    extra: Optional[Any]

    def get_create_date(self) -> str:
        return datetime.fromisoformat(self.created_at).date().isoformat()

    def get_content(self):
        result = []
        for content in self.content:
            result.append(content.content)
        return '\n'.join(result)

    def normalized_by_timeline(self):
        contents = []
        for content in self.content:
            if content.type == "text":
                contents.append(content.content)

        return f"[{self.get_create_date()}]: {''.join(contents)}"

    # -------------------------
    # factory method
    # -------------------------
    @staticmethod
    def from_dict(data: Dict) -> "NewsDetail":
        return NewsDetail(
            id=data["id"],
            title=data["title"],
            content=[
                ContentItem(
                    type=c.get("type"),
                    content=c.get("content", "")
                )
                for c in data.get("content", [])
            ],

            source=data.get("source"),
            author_id=data["author_id"],
            author_name=data["author_name"],
            author_profile_image_url=data.get("author_profile_image_url"),
            author_points=data["author_points"],
            author_role=data["author_role"],

            created_at=data["created_at"],
            updated_at=data["updated_at"],

            view_count=data["view_count"],
            tags=[Tag(**t) for t in data.get("tags", [])],
            tickers=data.get("tickers", []),
            content_labels=[ContentLabel(**c) for c in data.get("content_labels", [])],

            vote_stats=VoteStats(
                target_id=data["vote_stats"]["target_id"],
                vote_counts=VoteCounts(**data["vote_stats"]["vote_counts"]),
                total_count=data["vote_stats"]["total_count"],
                user_vote=data["vote_stats"]["user_vote"],
                vote_setting=None,  # 필요없는 데이터라서 None 처리함
            ),

            comment_count=data["comment_count"],

            like_stats=LikeStats(**data["like_stats"]),

            is_bookmarked=data["is_bookmarked"],
            is_deleted=data["is_deleted"],
            is_top_story=data["is_top_story"],
            hide_comments=data["hide_comments"],

            translations=data.get("translations"),
            extra=data.get("extra"),
        )
