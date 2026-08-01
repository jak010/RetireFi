import calendar
from datetime import datetime, date, timedelta


class TimeUtils:

    def get_week(self, date: datetime) -> str:
        """ ISO 주차 계산 """
        year, week, _ = date.isocalendar()
        return f"{year}-W{week:02d}"

    def get_completed_month_weeks(self) -> list[str]:
        today = date.today()

        year = today.year
        month = today.month

        last_day = calendar.monthrange(year, month)[1]

        weeks = []
        added = set()

        current = date(year, month, 1)

        while current.day <= last_day and current.month == month:
            iso_year, iso_week, iso_weekday = current.isocalendar()
            week_key = f"{iso_year}-W{iso_week:02d}"

            # 해당 날짜가 속한 주의 일요일 계산
            week_end = current + timedelta(days=(7 - iso_weekday))

            # 주가 완료되었다면 포함
            if week_end <= today and week_key not in added:
                weeks.append(week_key)
                added.add(week_key)

            current += timedelta(days=1)

        return weeks

if __name__ == '__main__':
    c = TimeUtils()
    print(c.get_completed_month_weeks())