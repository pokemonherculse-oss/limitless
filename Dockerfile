FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8000 LIMITLESS_EXCEL_PATH=/data/limitless.xlsx
VOLUME ["/data"]
EXPOSE 8000
CMD ["python", "-u", "server.py"]
