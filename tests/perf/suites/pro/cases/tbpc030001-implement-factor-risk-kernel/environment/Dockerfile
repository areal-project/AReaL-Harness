# 公开基础镜像固定到 linux/amd64 manifest。
FROM gcc:13.4.0-bookworm@sha256:ed4c7f6a03f119d013ed8fc58524549365e3be74d6388c401035401cb2ef04ef
ENV LANG=C.UTF-8
WORKDIR /app
COPY resources/ /app/
RUN gcc -std=c11 -shared -fPIC /app/factor_kernel.c -o /app/factor_kernel.so && rm /app/factor_kernel.c
RUN mkdir -p /logs/agent && chmod 0777 /logs /logs/agent
CMD ["sh", "-lc", "sleep infinity"]
