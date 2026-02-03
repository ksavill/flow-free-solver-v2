from __future__ import annotations

import os

import uvicorn

if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    reload = os.environ.get("RELOAD", "1").lower() in {"1", "true", "yes", "y", "on"}
    uvicorn.run("backend.app:app", host=host, port=port, reload=reload)
