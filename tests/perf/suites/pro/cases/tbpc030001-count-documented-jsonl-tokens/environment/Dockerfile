# 公开基础镜像固定到 linux/amd64 manifest。
FROM python:3.12.14-bookworm@sha256:c90be507635af19768837aa7eeb2f4ce89a74d62962a335497b9df8edfb7f19d
ENV LANG=C.UTF-8
WORKDIR /app
COPY resources/ /app/
RUN chmod 0444 /app/public/tokenizer/* /app/public/documented-token-counter-v1.md
RUN mkdir -p /logs/agent && chmod 0777 /logs /logs/agent
CMD ["sh", "-lc", "sleep infinity"]
