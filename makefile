deploy.dev:
	docker compose -f deploy/docker-compose.yml up -d;
	uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload

deploy.dummy:
	docker compose -f deploy/docker-compose.yml up -d;
	USE_DUMMY=true uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload


db.fetch:
	sqlacodegen mysql+pymysql://root:1234@localhost:9998/investra?charset=utf8 --outfile models.py

run.kospi.intraday:
#	streamlit run ./src/application/libs/market/engine/intraday/poliot/kospi/theme/live-theme2.py
	streamlit run ./src/application/libs/market/engine/intraday/poliot/kospi/theme/live-theme3.py
