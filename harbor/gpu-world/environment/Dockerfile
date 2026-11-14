FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl bash nodejs npm ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g opencode-ai@1.19.5 && opencode --version
RUN pip install --no-cache-dir numpy==2.1.3 scipy==1.14.1
COPY gpu /usr/local/bin/gpu
RUN chmod 755 /usr/local/bin/gpu
WORKDIR /app
