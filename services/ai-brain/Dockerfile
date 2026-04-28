FROM python:3.11-slim

WORKDIR /app

# Install dependencies before copying source for better layer caching.
RUN pip install --no-cache-dir \
    "fastapi>=0.111.0" \
    "uvicorn[standard]>=0.29.0" \
    "httpx>=0.27.0" \
    "pydantic>=2.7.0" \
    "asyncpg>=0.29.0"

COPY app/ ./app/

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
