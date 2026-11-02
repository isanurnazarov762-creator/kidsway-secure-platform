# KidsWay verifier: internal-only service. Models are downloaded and SHA-256 checked at build
# time, so the running container needs no internet at all.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 VERIFIER_HOST=0.0.0.0 VERIFIER_PORT=8000
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY kwverify ./kwverify
COPY server.py download_models.py ./
RUN python download_models.py && chmod -R a-w /srv
# Not root, no shell login, nothing writable but /tmp (tmpfs in compose)
RUN useradd --system --uid 10001 --no-create-home verifier
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=2).status==200 else 1)"
CMD ["python", "server.py"]
