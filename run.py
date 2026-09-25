"""Start the dashboard:  python run.py   → http://localhost:8000"""
import os
import sys
import threading
import webbrowser

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend"))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    print(f"\n  Amazon Ads Intelligence is running at  http://localhost:{port}\n  Press Ctrl+C to stop.\n")
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="warning")
