# Development Workflow & Commands

## 1. Environment & Dependencies
The backend relies on Python 3 and modern libraries including FastAPI, Uvicorn, BeautifulSoup4, Pandas, Pydantic, yfinance, LangChain, and Slack SDK.
- **Virtual Environment:** Ensure `venv/` is active (`source venv/bin/activate`).
- **Dependencies Installation:** `pip install -r requirements.txt`

## 2. Local Execution & Makefile Commands
The project defines automated workflow commands in `makefile`:

```bash
# 1. Start local development environment with Docker dependencies and live reload
make deploy.dev

# 2. Start application in dummy data test mode (bypasses active network scrapers)
make deploy.dummy

# 3. Fetch database models from local MySQL using sqlacodegen
make db.fetch

# 4. Run interactive Streamlit intraday theme tracking engine
make run.kospi.intraday
```

### Manual Server Startup
If executing directly via CLI without make:
```bash
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

## 3. Local AI Server Integration (Ollama)
For features utilizing AI news summarization (`news_summarizer_service.py`):
```bash
OLLAMA_MLX=1 ollama serve
```

## 4. Critical Project Behavioral Rules
- **Git Commit and Push Constraints:**
  - **NEVER** run `git commit` or `git push` autonomously under any circumstances unless explicitly ordered by the user in the active prompt (defined in `.agents/AGENTS.md`).
- **File & Editing Tools Prioritization:**
  - Always prefer specific tools over terminal shell workarounds (e.g., use `replace_file_content` for editing rather than `sed` or `cat`).
- **Documentation Preservation:**
  - Preserve all existing code comments and docstrings unless explicitly directed otherwise.
