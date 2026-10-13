FROM docker.io/python:3.14-slim
ENV PYTHONUNBUFFERED=1
ENV TZ=Europe/Madrid
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY livefeed/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY livefeed/ .

RUN useradd -u 500 -s /usr/sbin/nologin appuser \
    && mkdir -p /data && chown appuser:appuser /data
USER appuser

EXPOSE 8765
CMD ["python", "livefeed.py"]
