FROM python:3.12-slim

ARG INSTALAR_NAVEGADOR=1
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

# Solo si tu scraper usa Playwright; con INSTALAR_NAVEGADOR=0 la imagen pesa mucho menos
RUN if [ "$INSTALAR_NAVEGADOR" = "1" ]; then playwright install --with-deps chromium && chmod -R a+rX /ms-playwright; fi

COPY . .

RUN useradd -m -u 1000 app \
    && mkdir -p /app/storage/aprende \
    && chown -R app:app /app
USER app

EXPOSE 8000

# UN solo worker: el tiempo real (WebSocket) y el límite de intentos viven en memoria
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--ws-max-size", "4096"]