FROM docker.io/python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY livefeed/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY livefeed/ .

RUN useradd -u 500 -s /usr/sbin/nologin appuser
USER appuser

EXPOSE 8765
CMD ["python", "livefeed.py"]
