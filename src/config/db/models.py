import datetime
from typing import Optional

from sqlalchemy import DateTime, Index, String, text
from sqlalchemy.dialects.mysql import BIGINT, LONGTEXT, TINYINT
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ARTICLE(Base):
    __tablename__ = 'ARTICLE'
    __table_args__ = (
        Index('uk_source_source_pk', 'source', 'source_pk', unique=True),
    )

    id: Mapped[int] = mapped_column(BIGINT(20, unsigned=True), primary_key=True, comment='기사 PK')
    source: Mapped[str] = mapped_column(String(100, 'utf8mb4_unicode_ci'), nullable=False, comment='출처')
    source_pk: Mapped[str] = mapped_column(String(150, 'utf8mb4_unicode_ci'), nullable=False, comment='출처의 PK')
    title: Mapped[str] = mapped_column(String(500, 'utf8mb4_unicode_ci'), nullable=False, comment='제목')
    content: Mapped[str] = mapped_column(LONGTEXT(collation='utf8mb4_unicode_ci'), nullable=False, comment='내용')
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False,
                                                          server_default=text('CURRENT_TIMESTAMP'), comment='생성일')
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False, server_default=text(
        'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'), comment='수정일')
    is_edit: Mapped[Optional[int]] = mapped_column(TINYINT(1), comment='컨텐츠가 파싱되었')
    content_created_at: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, comment='원본 컨텐츠 생성일')
    reason: Mapped[Optional[str]] = mapped_column(LONGTEXT(collation='utf8mb4_unicode_ci'))


class ARTICLEWEEKLY(Base):
    __tablename__ = 'ARTICLE_WEEKLY'
    __table_args__ = (
        Index('uk_source_source_pk', 'week', unique=True),
    )

    id: Mapped[int] = mapped_column(BIGINT(20, unsigned=True), primary_key=True, comment='기사 PK')
    week: Mapped[str] = mapped_column(String(500, 'utf8mb4_unicode_ci'), nullable=False, comment='주차')
    title: Mapped[str] = mapped_column(String(500, 'utf8mb4_unicode_ci'), nullable=False, comment='제목')
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False,
                                                          server_default=text('CURRENT_TIMESTAMP'), comment='생성일')
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime, nullable=False, server_default=text(
        'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'), comment='수정일')
    content: Mapped[Optional[str]] = mapped_column(LONGTEXT(collation='utf8mb4_unicode_ci'))
